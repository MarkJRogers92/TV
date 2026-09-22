#!/usr/bin/env -S npx tsx
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { MediaItem, Pool } from "../src/domain/models.js";
import { mediaSessionSchema } from "../src/integrations/tunarr/types.js";
import {
  buildVoicedImportPlan,
  isPathInside,
  localMediaId,
  parseCsv,
} from "../src/continuity/voicedImport.js";

const values = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index]!;
  if (!arg.startsWith("--")) throw new Error(`Unexpected argument ${arg}`);
  const key = arg.slice(2);
  if (key === "apply" || key === "activate-hourly-ids") values.set(key, "true");
  else {
    const value = process.argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    values.set(key, value);
  }
}
const required = (name: string) => {
  const value = values.get(name);
  if (!value) throw new Error(`Missing --${name}`);
  return resolve(value);
};
const sourceRoot = required("source");
const destinationRoot = required("destination");
const apply = values.get("apply") === "true";
const activateHourlyIds = values.get("activate-hourly-ids") === "true";
if (activateHourlyIds && !apply)
  throw new Error("--activate-hourly-ids requires --apply");
const api = (values.get("api") ?? "http://127.0.0.1:4177").replace(/\/$/u, "");
const tunarrApi = (values.get("tunarr-api") ?? "http://127.0.0.1:8000").replace(/\/$/u, "");
const backupPath = resolve(values.get("backup") ?? `${tmpdir()}/marktv-voiced-import-${Date.now()}.json`);
const channelId = values.get("channel") ?? "marktv-laughs";

const manifest = parseCsv(await readFile(resolve(sourceRoot, "manifest.csv"), "utf8"));
const videos = parseCsv(await readFile(resolve(sourceRoot, "videos_manifest.csv"), "utf8"));
const plan = buildVoicedImportPlan({ sourceRoot, destinationRoot, channelId, manifest, videos });
const hashFile = async (path: string) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};
for (const item of plan) {
  if ((await hashFile(item.videoPath)) !== item.videoSha256)
    throw new Error(`Source video hash mismatch: ${item.baseName}`);
}

const requestJson = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${api}${path}`, init);
  if (!response.ok)
    throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
  return response.status === 204 ? undefined as T : await response.json() as T;
};
const assertTunarrHasNoSessions = async () => {
  const response = await fetch(`${tunarrApi}/api/sessions`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Tunarr session guard failed closed: HTTP ${response.status}`);
  const value: unknown = await response.json();
  const values: unknown[] = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.values(value as Record<string, unknown>).flatMap((entry) => Array.isArray(entry) ? entry : [entry])
      : [];
  if (!Array.isArray(value) && (!value || typeof value !== "object"))
    throw new Error("Tunarr session guard failed closed: unsupported response shape");
  const sessions = values.map((entry) => {
    const parsed = mediaSessionSchema.safeParse(entry);
    if (!parsed.success) throw new Error("Tunarr session guard failed closed: unsupported session record");
    return parsed.data;
  });
  const active = sessions.reduce((sum, session) => sum + (session.numConnections ?? 1), 0);
  if (active > 0) throw new Error(`Tunarr session guard blocked import: ${active} active connection(s)`);
};
const sameImportedRecord = (existing: MediaItem, expected: MediaItem) =>
  ["id", "source", "path", "kind", "title", "durationMs", "durationStatus", "showTitle", "season", "episode", "available", "tags", "tunarrProgramId", "revision"]
    .every((key) => JSON.stringify(existing[key as keyof MediaItem]) === JSON.stringify(expected[key as keyof MediaItem]));
const media = await requestJson<MediaItem[]>("/api/v1/media");
const roots = await requestJson<Array<{ path: string }>>("/api/v1/media/roots");
if (!roots.some((root) => isPathInside(root.path, destinationRoot)))
  throw new Error("Destination is outside every registered MarkTV media root");
const mediaById = new Map(media.map((item) => [item.id, item]));
const plannedItems = plan.map((item) => {
  const path = resolve(destinationRoot, basename(item.videoPath));
  const imported: MediaItem = {
    id: localMediaId(path), source: "local-folder", path, kind: item.kind,
    title: item.title, durationMs: item.durationMs, durationStatus: "ok",
    available: true, tags: item.tags,
  };
  const current = mediaById.get(imported.id);
  if (current && !sameImportedRecord(current, imported))
    throw new Error(`Catalog identity metadata conflict for ${item.baseName}; refusing to overwrite existing tags/source/availability/revision`);
  const pathOwner = media.find((existing) => existing.path === imported.path && existing.id !== imported.id);
  if (pathOwner) throw new Error(`Destination path already belongs to ${pathOwner.id}`);
  return { source: item, imported, exists: Boolean(current), identical: Boolean(current) };
});

let idsPool: Pool | undefined;
let channel: { id: string; number: number; breakPolicy?: { stationIdPoolIds: string[] } } | undefined;
let updatedPool: Pool | undefined;
if (activateHourlyIds) {
  channel = await requestJson(`/api/v1/channels/${encodeURIComponent(channelId)}`);
  if (!channel || channel.id !== "marktv-laughs" || channel.number !== 7 ||
      !channel.breakPolicy?.stationIdPoolIds.includes("ids"))
    throw new Error("Hourly ID activation is limited to channel 7's existing ids station-ID pool");
  const pools = await requestJson<Pool[]>("/api/v1/pools");
  idsPool = pools.find((pool) => pool.id === "ids");
  if (!idsPool || !idsPool.kinds.includes("station-id"))
    throw new Error("The existing ids station-ID pool is unavailable");
  const eligibleIds = plannedItems
    .filter(({ imported }) => imported.kind === "station-id" && imported.tags.includes("continuity-hourly-ids-eligible"))
    .map(({ imported }) => imported.id);
  const nextIds = [...new Set([...idsPool.mediaIds, ...eligibleIds])];
  if (nextIds.length !== idsPool.mediaIds.length + eligibleIds.filter((id) => !idsPool!.mediaIds.includes(id)).length)
    throw new Error("Unexpected station-ID pool collision");
  updatedPool = { ...idsPool, mediaIds: nextIds };
}

const destinationExisting = await Promise.all(plan.map(async (item) => {
  const path = resolve(destinationRoot, basename(item.videoPath));
  try {
    const file = await stat(path);
    if (!file.isFile() || await hashFile(path) !== item.videoSha256)
      throw new Error(`Destination file conflict: ${path}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}));

console.log(JSON.stringify({
  mode: apply ? "apply" : "dry-run",
  sourceVideos: plan.length,
  duplicateAudioRowsExcluded: manifest.filter((row) => row.video_status === "excluded_byte_identical_audio").length,
  alreadyOnDisk: destinationExisting.filter(Boolean).length,
  filesToCopy: destinationExisting.filter((exists) => !exists).length,
  alreadyRegistered: plannedItems.filter((item) => item.exists).length,
  catalogRecordsToRegister: plannedItems.filter((item) => !item.exists).length,
  staged: plannedItems.filter((item) => item.imported.tags.some((tag) => tag.startsWith("continuity-staged-reason="))).map((item) => ({
    baseName: item.source.baseName,
    reason: item.imported.tags.find((tag) => tag.startsWith("continuity-staged-reason="))?.split("=")[1],
  })),
  stationIdsForHourlyPool: plannedItems.filter((item) => item.imported.kind === "station-id" && item.imported.tags.includes("continuity-hourly-ids-eligible")).map((item) => item.source.baseName),
  destinationRoot,
  backupPath: apply ? backupPath : "not created in dry-run",
  hourlyPoolActivation: activateHourlyIds ? {
    channelId,
    poolId: idsPool?.id,
    adds: updatedPool && idsPool ? updatedPool.mediaIds.length - idsPool.mediaIds.length : 0,
  } : "not requested",
}, null, 2));
if (!apply) process.exit(0);

await assertTunarrHasNoSessions();
const freshMedia = await requestJson<MediaItem[]>("/api/v1/media");
for (const { imported } of plannedItems) {
  const before = mediaById.get(imported.id);
  const now = freshMedia.find((item) => item.id === imported.id);
  if (Boolean(before) !== Boolean(now) || (before && now && !sameImportedRecord(now, before)))
    throw new Error(`Catalog changed during preflight for ${imported.title}`);
}
if (idsPool) {
  const freshPools = await requestJson<Pool[]>("/api/v1/pools");
  if (JSON.stringify(freshPools.find((pool) => pool.id === idsPool!.id)) !== JSON.stringify(idsPool))
    throw new Error("The ids pool changed during preflight");
}

const snapshot = {
  createdAt: new Date().toISOString(),
  api,
  tunarrApi,
  destinationRoot,
  media: plannedItems.map(({ imported }) => ({ id: imported.id, previous: mediaById.get(imported.id) ?? null })),
  pool: idsPool ?? null,
};
await writeFile(backupPath, JSON.stringify(snapshot, null, 2), { flag: "wx", mode: 0o600 });
const createdCatalogIds: string[] = [];
let poolWriteAttempted = false;
try {
  await mkdir(destinationRoot, { recursive: true });
  for (const [index, item] of plan.entries()) {
    const destination = resolve(destinationRoot, basename(item.videoPath));
    if (!destinationExisting[index]) await copyFile(item.videoPath, destination, 0x1);
    if (await hashFile(destination) !== item.videoSha256)
      throw new Error(`Copied file hash mismatch: ${item.baseName}`);
  }
  for (const { imported, identical } of plannedItems) {
    if (identical) continue;
    createdCatalogIds.push(imported.id);
    const response = await fetch(`${api}/api/v1/media/${encodeURIComponent(imported.id)}`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(imported),
    });
    if (!response.ok) throw new Error(`Could not register ${imported.title}: ${response.status} ${await response.text()}`);
  }
  if (activateHourlyIds && idsPool && updatedPool) {
    const freshPools = await requestJson<Pool[]>("/api/v1/pools");
    if (JSON.stringify(freshPools.find((pool) => pool.id === idsPool.id)) !== JSON.stringify(idsPool))
      throw new Error("The ids pool changed during import");
    await assertTunarrHasNoSessions();
    poolWriteAttempted = true;
    await requestJson(`/api/v1/pools/${encodeURIComponent(updatedPool.id)}`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(updatedPool),
    });
  }
} catch (error) {
  const rollbackErrors: string[] = [];
  if (poolWriteAttempted && idsPool) {
    try {
      await requestJson(`/api/v1/pools/${encodeURIComponent(idsPool.id)}`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(idsPool),
      });
    } catch (rollbackError) { rollbackErrors.push(`pool rollback: ${String(rollbackError)}`); }
  }
  for (const id of createdCatalogIds.reverse()) {
    try {
      const response = await fetch(`${api}/api/v1/media/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok && response.status !== 404) rollbackErrors.push(`catalog delete ${id}: HTTP ${response.status}`);
    } catch (rollbackError) { rollbackErrors.push(`catalog delete ${id}: ${String(rollbackError)}`); }
  }
  const suffix = rollbackErrors.length ? ` Rollback issues: ${rollbackErrors.join("; ")}.` : " Catalog and pool rollback completed; verified copied files were retained for recovery.";
  throw new Error(`Import failed: ${String(error)}.${suffix} Snapshot: ${backupPath}`);
}
console.log(`Imported ${plan.length} verified voiced video records${activateHourlyIds ? " and activated their station IDs for channel 7 hourly breaks" : ""}.`);
