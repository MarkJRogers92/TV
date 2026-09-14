import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Schedule } from "../domain/models.js";

const MARKTV_VERSION = "0.1.0";
const SCHEMA_VERSION = 1;

function channelSlug(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "channel"
  );
}

function exportName(schedule: Schedule) {
  return `${channelSlug(schedule.channelId)}-${schedule.date}.marktv.json`;
}

function alternateExportName(schedule: Schedule) {
  const generationKey = createHash("sha256")
    .update(schedule.id)
    .digest("hex")
    .slice(0, 16);
  return `${channelSlug(schedule.channelId)}-${schedule.date}-${generationKey}.marktv.json`;
}

function buildArtifact(schedule: Schedule) {
  const programEntries = schedule.entries.filter(
    (entry) => entry.kind !== "flex",
  );
  const hasInvalidPath = programEntries.some(
    (entry) => !entry.path || !isAbsolute(entry.path),
  );
  const blockingReasons = hasInvalidPath
    ? ["MEDIA_PATH_MISSING_OR_RELATIVE"]
    : [];
  return {
    schemaVersion: SCHEMA_VERSION,
    marktvVersion: MARKTV_VERSION,
    channel: {
      id: schedule.channelId,
      name: schedule.channelName ?? schedule.channelId,
      number: schedule.channelNumber,
      timezone: schedule.timezone,
    },
    generation: {
      id: schedule.id,
      date: schedule.date,
      seed: schedule.seed,
      generatedAt: schedule.generatedAt,
      configurationRevision: schedule.revision,
      inputFingerprint: schedule.id,
      durationMs: schedule.durationMs,
    },
    entries: schedule.entries,
    breakPolicy: schedule.breakPolicy ?? null,
    fillerRoles: [
      ...new Set(
        schedule.entries
          .filter((entry) =>
            ["commercial", "filler", "station-id", "bumper"].includes(
              entry.kind,
            ),
          )
          .map((entry) => entry.kind),
      ),
    ],
    diagnostics: schedule.diagnostics,
    sync: { eligible: blockingReasons.length === 0, blockingReasons },
  };
}

export async function writeScheduleExport(
  schedule: Schedule,
  destinationDir: string,
): Promise<string> {
  await mkdir(destinationDir, { recursive: true });
  const artifact = `${JSON.stringify(buildArtifact(schedule), null, 2)}\n`;
  let target = join(destinationDir, exportName(schedule));
  const temporary = `${target}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, artifact, { encoding: "utf8", flag: "wx" });
    for (;;) {
      try {
        await link(temporary, target);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existingText = await readFile(target, "utf8");
        if (existingText === artifact) break;
        let existing: { generation?: { id?: string } } = {};
        try {
          existing = JSON.parse(existingText) as typeof existing;
        } catch {
          // A conflicting non-MarkTV file must remain untouched.
        }
        if (existing.generation?.id === schedule.id) break;
        const alternate = join(destinationDir, alternateExportName(schedule));
        if (target === alternate)
          throw new Error(`Export identity collision at ${target}`);
        target = alternate;
      }
    }
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return target;
}
