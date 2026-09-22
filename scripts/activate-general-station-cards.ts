#!/usr/bin/env -S npx tsx
import type { MediaItem, Pool } from "../src/domain/models.js";
import { resolve } from "node:path";

const values = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!name?.startsWith("--") || !value) throw new Error(`Invalid argument near ${name ?? "end"}`);
  values.set(name.slice(2), value);
}
const api = (values.get("api") ?? "http://127.0.0.1:4177").replace(/\/$/u, "");
const tunarr = (values.get("tunarr") ?? "http://127.0.0.1:8000").replace(/\/$/u, "");
const rootValue = values.get("root");
if (!rootValue) throw new Error("Missing --root");
const root = resolve(rootValue);
const get = async <T>(path: string): Promise<T> => {
  const response = await fetch(`${api}${path}`);
  if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
  return response.json() as Promise<T>;
};
const putPool = async (pool: Pool) => {
  const response = await fetch(`${api}/api/v1/pools/${encodeURIComponent(pool.id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(pool),
  });
  if (!response.ok) throw new Error(`Pool ${pool.id} update failed: ${response.status} ${await response.text()}`);
};

const sessionsResponse = await fetch(`${tunarr}/api/sessions`);
if (!sessionsResponse.ok)
  throw new Error(`Cannot prove viewer safety: Tunarr sessions returned ${sessionsResponse.status}`);
const sessions = await sessionsResponse.json() as unknown;
const connectionCount = (value: unknown): number => {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + connectionCount(item), 0);
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  if (typeof record.numConnections === "number") return record.numConnections;
  if (Array.isArray(record.connections)) return record.connections.length;
  return Object.values(record).reduce((sum, item) => sum + connectionCount(item), 0);
};
if (connectionCount(sessions) > 0)
  throw new Error("ACTIVE_VIEWERS: general-card activation is deferred until playback stops");

const [media, pools] = await Promise.all([
  get<MediaItem[]>("/api/v1/media"),
  get<Pool[]>("/api/v1/pools"),
]);
const byId = new Map(media.map((item) => [item.id, item]));
const generated = media.filter(
  (item) =>
    item.kind === "station-id" &&
    item.path.startsWith(`${root}/`) &&
    item.tags.includes("user-approved-legacy-card") &&
    item.tags.includes("visual-only"),
);
if (generated.length !== 17)
  throw new Error(`Expected 17 registered general station cards, found ${generated.length}`);

const ids = pools.find((pool) => pool.id === "ids");
const bumpers = pools.find((pool) => pool.id === "marktv-general-bumpers");
if (!ids || !bumpers) throw new Error("Expected station ID and general bumper pools");

const safeExistingIds = ids.mediaIds.filter(
  (id) => !byId.get(id)?.title.toLowerCase().includes("late-night-317am"),
);
const nextIds = [...new Set([...safeExistingIds, ...generated.map((item) => item.id)])].sort();
const safeBumpers = bumpers.mediaIds.filter(
  (id) => !byId.get(id)?.title.toLowerCase().includes("technical-difficulties"),
);
if (nextIds.length !== safeExistingIds.length + 17)
  throw new Error("General cards were already partly present; refusing an ambiguous activation");
if (ids.mediaIds.length - safeExistingIds.length !== 1)
  throw new Error("Expected exactly one unscoped 3:17 AM station ID");
if (bumpers.mediaIds.length - safeBumpers.length !== 1)
  throw new Error("Expected exactly one technical-difficulties bumper");

const freshPools = await get<Pool[]>("/api/v1/pools");
if (JSON.stringify(freshPools.find((pool) => pool.id === ids.id)) !== JSON.stringify(ids))
  throw new Error("Station ID pool changed during activation; retry from a fresh snapshot");
if (JSON.stringify(freshPools.find((pool) => pool.id === bumpers.id)) !== JSON.stringify(bumpers))
  throw new Error("General bumper pool changed during activation; retry from a fresh snapshot");

await putPool({ ...ids, mediaIds: nextIds });
try {
  const beforeSecondWrite = await get<Pool[]>("/api/v1/pools");
  if (
    JSON.stringify(beforeSecondWrite.find((pool) => pool.id === bumpers.id)) !==
    JSON.stringify(bumpers)
  )
    throw new Error("General bumper pool changed during activation");
  await putPool({ ...bumpers, mediaIds: safeBumpers });
} catch (error) {
  await putPool(ids);
  throw error;
}
console.log(
  `Future-only pool activation complete: ${generated.length} general station cards added; ` +
    "3:17 AM and technical-difficulties assets removed from shuffle pools.",
);
