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

const sessionsResponse = await fetch(`${tunarr}/api/sessions`);
if (!sessionsResponse.ok)
  throw new Error(`Cannot prove viewer safety: Tunarr sessions returned ${sessionsResponse.status}`);
const sessions = (await sessionsResponse.json()) as unknown;
const connectionCount = (value: unknown): number => {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + connectionCount(item), 0);
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  if (typeof record.numConnections === "number") return record.numConnections;
  if (Array.isArray(record.connections)) return record.connections.length;
  return Object.values(record).reduce((sum, item) => sum + connectionCount(item), 0);
};
if (connectionCount(sessions) > 0)
  throw new Error("ACTIVE_VIEWERS: general-card rollback is deferred until playback stops");

const [media, pools] = await Promise.all([
  get<MediaItem[]>("/api/v1/media"),
  get<Pool[]>("/api/v1/pools"),
]);
const generatedIds = new Set(
  media
    .filter(
      (item) =>
        item.kind === "station-id" &&
        item.path.startsWith(`${root}/`) &&
        item.tags.includes("user-approved-legacy-card") &&
        item.tags.includes("visual-only"),
    )
    .map((item) => item.id),
);
if (generatedIds.size !== 17)
  throw new Error(`Expected 17 registered general station cards, found ${generatedIds.size}`);
const ids = pools.find((pool) => pool.id === "ids");
if (!ids) throw new Error("Station ID pool is missing");
const mediaIds = ids.mediaIds.filter((id) => !generatedIds.has(id));
if (ids.mediaIds.length - mediaIds.length !== 17)
  throw new Error("Expected exactly 17 active general cards; refusing ambiguous rollback");
const freshIds = (await get<Pool[]>("/api/v1/pools")).find((pool) => pool.id === ids.id);
if (JSON.stringify(freshIds) !== JSON.stringify(ids))
  throw new Error("Station ID pool changed during rollback; retry from a fresh snapshot");
const response = await fetch(`${api}/api/v1/pools/${encodeURIComponent(ids.id)}`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ...ids, mediaIds }),
});
if (!response.ok) throw new Error(`Rollback failed: ${response.status} ${await response.text()}`);
console.log(
  "Removed 17 generated general cards from future station-ID selection. " +
    "Media files and catalog records were preserved; quarantined legacy items remain excluded.",
);
