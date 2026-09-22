import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Channel, MediaItem, Pool, Schedule } from "../domain/models.js";
import type { Repositories } from "../db/repositories.js";
import { scheduleScopedContinuityTag } from "../domain/models.js";
import { confirmContinuityMedia, continuityLibrary, insideLibrary } from "./library.js";
import { listMediaRoots } from "../media/roots.js";
import {
  generatedContinuityTags,
  generatedFileName,
  generatedMediaId,
} from "./assets.js";
import { inspectCanonicalLogo } from "./branding.js";
import { planContinuityCards, type ContinuityCardPlan } from "./director.js";
import { templateForCardType } from "./families.js";
import {
  cardSvg,
  decodeRendered,
  probeRendered,
  rasterArgs,
  readTemplate,
  runFfmpeg,
  selectFfmpegBinary,
  writeTextFiles,
} from "./offline.js";
import {
  canPlaceCard,
  type ContinuityEnvironment,
} from "./publish.js";
import type { ContinuityConfig, ContinuityHistoryEntry } from "./types.js";

export const GENERATED_CONTINUITY_DIRECTORY = join("generated", "continuity");
/**
 * Renders per preparation pass.
 *
 * Generous on purpose: the planner's acceptance predicate is the fit check, so
 * every card it names is one the later apply pass can actually insert. Stopping
 * early would leave the apply pass free to fall back to a different card for
 * the same break, which would then diverge from the rendered set.
 */
const DEFAULT_MAX_RENDERS = 24;
const DEFAULT_PREPARE_BUDGET_MS = 8 * 60_000;

export type ContinuityPrepareInput = {
  repositories: Repositories;
  channel: Channel;
  schedule: Schedule;
  media: MediaItem[];
  pools?: Pool[];
  config: ContinuityConfig;
  history: ContinuityHistoryEntry[];
  /** Yesterday's completed schedule, when a card may name a carried film. */
  adjacentSchedules?: Schedule[];
  repoRoot?: string;
  /** Explicit output directory; the offline verifier points this at a temp dir. */
  outputRoot?: string;
  /** Write the finished cards into the catalog. Off for read-only tooling. */
  register?: boolean;
  ffmpeg?: string;
  ffprobe?: string;
  font?: string;
  maxRenders?: number;
  budgetMs?: number;
  timeoutMs?: number;
  now?: Date;
  log?: (message: string) => void;
};

export type ContinuityPrepareOutcome = {
  /** The catalog plus every generated card, whether or not it was registered. */
  media: MediaItem[];
  prepared: MediaItem[];
  diagnostics: Array<{ code: string; message: string }>;
  rasterSupported: boolean;
  outputRoot?: string;
};

export type ContinuityPreparer = (
  input: ContinuityPrepareInput,
) => Promise<ContinuityPrepareOutcome>;

const hashFile = (path: string) =>
  new Promise<string>((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });

const fileExists = async (path: string) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const tagValue = (tags: string[], prefix: string) =>
  tags.find((tag) => tag.startsWith(prefix))?.slice(prefix.length);

/**
 * The writable library folder generated cards are published under.
 *
 * Tunarr only resolves media that lives inside a mapped library root, so the
 * cards must be written beneath one. The root is chosen from the *existing*
 * media-root and catalog state - ideally the folder that already holds the
 * channel's commercials - and never hardcoded to one machine's volume. When no
 * root can be established the caller skips generation entirely rather than
 * writing media that could never reach the lineup.
 */
export function selectContinuityOutputRoot(input: {
  repositories: Repositories;
  media: MediaItem[];
  override?: string;
  mappedRoots?: string[];
}): string | undefined {
  if (input.override) return input.override;
  const roots = listMediaRoots(input.repositories).filter((root) =>
    !input.mappedRoots || input.mappedRoots.some((mapped) => insideLibrary(mapped, root.path)),
  );
  if (!roots.length) return undefined;
  const localInterstitials = input.media.filter(
    (item) =>
      item.source === "local-folder" &&
      Boolean(item.path) &&
      (item.kind === "commercial" || item.kind === "filler"),
  );
  const scored = roots
    .map((root) => {
      const prefix = root.path.endsWith("/") ? root.path : `${root.path}/`;
      const inside = localInterstitials.filter((item) => item.path!.startsWith(prefix)).length;
      // A folder the operator already named for commercials is the natural
      // home even before the catalog has any of its media.
      const nameBonus = /commercial/iu.test(root.path) ? 1_000_000 : 0;
      return { root, score: nameBonus + inside };
    })
    .sort((left, right) => right.score - left.score || left.root.path.localeCompare(right.root.path));
  const best = scored[0];
  if (!best || best.score === 0) return undefined;
  return join(best.root.path, GENERATED_CONTINUITY_DIRECTORY);
}

/**
 * Automatic offline preparation for one completed schedule.
 *
 * Runs after the final normal schedule and before continuity is applied: it
 * plans the day's cards, renders only those whose break can actually be rebuilt
 * exactly, validates every file against the one approved profile, and registers
 * the survivors as ordinary local media. There is no online call and no manual
 * command per day. Every failure path - no logo, no usable render tool, no
 * writable eligible root, a failed render or registration - returns the
 * original media so the ordinary schedule is untouched.
 */
export const prepareContinuityMedia: ContinuityPreparer = async (input) => {
  const diagnostics: Array<{ code: string; message: string }> = [];
  const ordinaryMedia = input.media.filter((item) => !item.tags.includes(scheduleScopedContinuityTag));
  const unchanged = (outputRoot?: string): ContinuityPrepareOutcome => ({
    media: input.config.enabled ? ordinaryMedia : input.media,
    prepared: [],
    diagnostics,
    rasterSupported: false,
    outputRoot,
  });
  const log = input.log ?? (() => {});
  const repoRoot = input.repoRoot ?? process.cwd();
  if (!input.config.enabled) return unchanged();
  const environment: ContinuityEnvironment = {
    channel: input.channel,
    pools: input.pools ?? input.repositories.pools.list(),
    adjacentSchedules: input.adjacentSchedules,
  };

  const fitOnly = (plan: ContinuityCardPlan) =>
    canPlaceCard({
      schedule: input.schedule,
      media: input.media,
      plan,
      environment,
      config: input.config,
    });
  // The same acceptance predicate the apply pass uses, minus the "asset already
  // exists" half: the cards that survive it are exactly the ones worth
  // rendering, so the two passes agree on which break carries which card.
  const plans = planContinuityCards({
    schedule: input.schedule,
    media: input.media,
    config: input.config,
    history: input.history,
    adjacentSchedules: input.adjacentSchedules,
    isAvailable: fitOnly,
  }).plans;
  if (!plans.length) return unchanged();

  const register = input.register ?? true;
  const library = register
    ? await continuityLibrary(input.repositories, input.channel.id).catch(() => undefined)
    : undefined;
  const outputRoot = register && !library ? undefined : selectContinuityOutputRoot({
    repositories: input.repositories,
    media: input.media,
    override: input.outputRoot,
    mappedRoots: library?.libraries.map((root) => root.path),
  });
  if (!outputRoot || (library && !library.libraries.some((root) => insideLibrary(root.path, outputRoot)))) {
    diagnostics.push({
      code: "CONTINUITY_NO_OUTPUT_ROOT",
      message:
        "No mapped library root could be selected for generated continuity cards; no card was prepared",
    });
    return unchanged();
  }
  const branding = await inspectCanonicalLogo(repoRoot);
  if (branding.state !== "bound") {
    diagnostics.push({
      code: "CONTINUITY_LOGO_UNAVAILABLE",
      message: `Canonical logo is ${branding.state}; no card was prepared`,
    });
    return unchanged(outputRoot);
  }
  const ffmpeg = input.ffmpeg ?? (await selectFfmpegBinary());
  if (!ffmpeg) {
    diagnostics.push({
      code: "CONTINUITY_NO_RENDER_TOOL",
      message:
        "No installed ffmpeg build can render card text (drawtext); no card was prepared",
    });
    return unchanged(outputRoot);
  }
  const ffprobe = input.ffprobe ?? "ffprobe";
  const logoBuffer = await readFile(join(repoRoot, "assets", "branding", branding.expectedFile));
  const logoDataUri = `data:image/png;base64,${logoBuffer.toString("base64")}`;

  const maxRenders = input.maxRenders ?? DEFAULT_MAX_RENDERS;
  const deadline = Date.now() + (input.budgetMs ?? DEFAULT_PREPARE_BUDGET_MS);
  const media = [...ordinaryMedia];
  const mediaById = new Map(input.media.map((item) => [item.id, item]));
  const prepared: MediaItem[] = [];

  for (const plan of plans) {
    if (prepared.length >= maxRenders) break;
    if (Date.now() > deadline) {
      diagnostics.push({
        code: "CONTINUITY_PREPARE_BUDGET",
        message: "Continuity offline preparation ran out of its time budget",
      });
      break;
    }
    if (
      !canPlaceCard({
        schedule: input.schedule,
        media,
        plan,
        environment,
        config: input.config,
      })
    ) {
      diagnostics.push({
        code: "CONTINUITY_NO_EXACT_FIT",
        message: `No exact fit for the ${plan.cardType} card at ${plan.insertionInstant}`,
      });
      continue;
    }
    const mediaId = generatedMediaId(plan);
    const fileName = generatedFileName(plan);
    const directory = join(
      outputRoot,
      input.channel.id,
      plan.broadcastDate,
      plan.contentHash.slice(0, 12),
    );
    const cardPath = join(directory, fileName);
    const tags = generatedContinuityTags(plan);

    const registered = register ? mediaById.get(mediaId) : undefined;
    if (
      registered &&
      registered.path === cardPath &&
      registered.durationMs === plan.durationMs &&
      tags.every((tag) => registered.tags.includes(tag)) &&
      (await fileExists(cardPath)) &&
      (await hashFile(cardPath)) === tagValue(registered.tags, "continuity-file=")
    ) {
      prepared.push(registered);
      media.push(registered);
      continue;
    }

    const temporary = join(directory, `.render-${process.pid}-${prepared.length}`);
    try {
      await mkdir(directory, { recursive: true });
      await mkdir(temporary, { recursive: true });
      const template = await readTemplate(repoRoot, templateForCardType[plan.cardType]);
      const svg = cardSvg({ plan, template, production: true, logoDataUri });
      const svgPath = join(directory, `${fileName.replace(/\.mp4$/u, "")}.svg`);
      await writeFile(join(temporary, "card.svg"), svg, "utf8");
      const textFiles = await writeTextFiles(temporary, plan);
      const mp4Temp = join(temporary, fileName);
      await runFfmpeg(
        ffmpeg,
        rasterArgs({
          plan,
          logoPath: join(repoRoot, "assets", "branding", branding.expectedFile),
          outputPath: mp4Temp,
          textFiles,
          font: input.font ?? "font=Arial",
          still: false,
        }),
        input.timeoutMs,
      );
      await decodeRendered(ffmpeg, mp4Temp);
      const probe = await probeRendered(ffprobe, mp4Temp);
      if (!probe.profileValid)
        throw new Error("Rendered profile does not match the approved card profile");
      if (Math.abs(probe.durationMs - plan.durationMs) > 120)
        throw new Error(
          `Rendered duration ${probe.durationMs}ms differs from planned ${plan.durationMs}ms`,
        );
      const fileHash = await hashFile(mp4Temp);
      // Atomic publish: nothing is ever visible in the library until a fully
      // validated file is renamed into place under its final name.
      await rename(mp4Temp, cardPath);
      await rename(join(temporary, "card.svg"), svgPath);
      const item: MediaItem = {
        id: mediaId,
        source: "local-folder",
        path: cardPath,
        kind: "bumper",
        title: plan.id,
        durationMs: probe.durationMs,
        durationStatus: "ok",
        available: true,
        tags: [...tags, `continuity-file=${fileHash}`, "continuity-probe=ok"],
      };
      await writeFile(
        `${cardPath}.manifest.json`,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            plan,
            mediaId,
            contentHash: plan.contentHash,
            fileHash,
            durationMs: probe.durationMs,
            profileValid: probe.profileValid,
            preparedAt: (input.now ?? new Date()).toISOString(),
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      if (register) input.repositories.media.put(item);
      media.push(item);
      mediaById.set(item.id, item);
      prepared.push(item);
      log(`Prepared continuity ${plan.cardType} card -> ${cardPath}`);
    } catch (error) {
      diagnostics.push({
        code: "CONTINUITY_RENDER_FAILED",
        message: `${
          plan.cardType
        } card was not prepared: ${error instanceof Error ? error.message : "unknown error"}`,
      });
    } finally {
      await rm(temporary, { recursive: true, force: true }).catch(() => {});
    }
  }

  let playable = prepared;
  if (library && prepared.length) {
    try {
      playable = await confirmContinuityMedia(library, prepared);
    } catch {
      playable = [];
    }
    if (playable.length !== prepared.length) diagnostics.push({
      code: "CONTINUITY_LIBRARY_PENDING",
      message: "Unconfirmed card files were skipped; ordinary breaks are retained",
    });
  }
  return {
    media: [...ordinaryMedia, ...playable],
    prepared: playable,
    diagnostics,
    rasterSupported: true,
    outputRoot,
  };
};
