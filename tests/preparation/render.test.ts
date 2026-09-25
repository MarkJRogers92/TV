import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import { createRepositories } from "../../src/db/repositories.js";
import { preparationEligibleMedia } from "../../src/preparation/eligibleMedia.js";
import { createPreparationExecutor } from "../../src/preparation/executor.js";
import { readSourceVersionSync } from "../../src/preparation/sourceVersion.js";
import { collectPreflightEvidence } from "../../src/preparation/preflight.js";
import { renderPreparedRendition } from "../../src/preparation/render.js";

const run = promisify(execFile);
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

test("settled source is remuxed, fully decoded, catalogued, and selected under its original pool ID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "marktv-prepared-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, "episode.mkv");
  await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=24",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1", "-shortest",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", sourcePath]);
  const source = readSourceVersionSync(sourcePath);
  const repositories = createRepositories(openDatabase(join(directory, "data")));
  cleanups.push(() => { repositories.close(); });
  const item = {
    id: "episode-1", source: "local-folder" as const, path: sourcePath,
    fileSizeBytes: source.sizeBytes, fileModifiedMs: source.modifiedMs,
    deviceId: source.deviceId, inode: source.inode,
    kind: "episode" as const, title: "Episode", showTitle: "Show", season: 1, episode: 1,
    durationMs: 1_000, durationStatus: "ok" as const, available: true,
    tags: ["preparation:needs-remux"],
  };
  repositories.media.put(item);
  repositories.preparation.observe({ sourceMediaId: item.id, source, observedAt: "2026-09-24T12:00:00Z" });
  repositories.preparation.observe({ sourceMediaId: item.id, source, observedAt: "2026-09-24T12:01:00Z" });
  await createPreparationExecutor(repositories).runOnce();

  const job = repositories.preparation.jobs.list()[0]!;
  expect(job).toMatchObject({ state: "completed", classification: "needs_remux",
    fullDecodeEvidence: { status: "deferred" }, rendition: { validation: { fullDecode: { status: "passed" } } } });
  expect(job.rendition).not.toBeNull();
  expect((await stat(job.rendition!.path)).size).toBeGreaterThan(0);
  expect(repositories.media.get(`prepared-${job.rendition!.id}`)).toMatchObject({
    sourceMediaId: item.id, path: job.rendition!.path,
  });
  expect(preparationEligibleMedia(repositories, [item])).toMatchObject([{ id: item.id, path: job.rendition!.path }]);
  expect(readSourceVersionSync(sourcePath)).toEqual(source);
  const before = await stat(job.rendition!.path);
  const reused = await renderPreparedRendition({ job,
    evidence: await collectPreflightEvidence(sourcePath, { level: "sampled" }),
    mode: "remux", cacheDirectory: repositories.preparation.cacheDirectory });
  expect(reused.rendition.path).toBe(job.rendition!.path);
  expect((await stat(job.rendition!.path)).mtimeMs).toBe(before.mtimeMs);
});

test("only a matching proven quarantine suppresses scheduling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "marktv-quarantine-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, "broken.mp4");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(sourcePath, "broken");
  const source = readSourceVersionSync(sourcePath);
  const repositories = createRepositories(openDatabase(join(directory, "data")));
  cleanups.push(() => { repositories.close(); });
  const item = { id: "broken", source: "local-folder" as const, path: sourcePath,
    fileSizeBytes: source.sizeBytes, fileModifiedMs: source.modifiedMs,
    deviceId: source.deviceId, inode: source.inode,
    kind: "movie" as const, title: "Broken", durationMs: 1_000,
    durationStatus: "ok" as const, available: true, tags: [] };
  repositories.preparation.observe({ sourceMediaId: item.id, source, observedAt: "2026-09-24T12:00:00Z" });
  repositories.preparation.observe({ sourceMediaId: item.id, source, observedAt: "2026-09-24T12:01:00Z" });
  const claimed = repositories.preparation.claimNext(() => source)!;
  repositories.preparation.complete({ id: claimed.id, attempt: claimed.attempt },
    { classification: "quarantined", failureKind: "decode_corruption" }, source);
  expect(preparationEligibleMedia(repositories, [item])[0]!.available).toBe(false);
  expect(preparationEligibleMedia(repositories, [{ ...item, fileSizeBytes: "different" }])[0]!.available).toBe(true);
});
