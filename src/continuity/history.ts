import { z } from "zod";
import type { Repositories } from "../db/repositories.js";
import type { ContinuityHistoryEntry, ContinuityPersona } from "./types.js";

const personaSchema = z.enum(["network", "local", "overnight", "odd", "existing-unclassified"]);
const cardTypeSchema = z.enum(["next", "next-later", "tonight", "weekend", "after-dark"]);
const familySchema = z.enum(["syndication", "local-cable", "prime-time", "overnight"]);

/**
 * Optional director metadata.
 *
 * Older records predate the director and simply omit it; the merged object is
 * spread into the parsed decision so a legacy row still validates.
 */
const directorFields = {
  cardType: cardTypeSchema.optional(),
  family: familySchema.optional(),
  targetKey: z.string().min(1).optional(),
};

const decisionSchema = z.discriminatedUnion("state", [
  z.object({
    id: z.string().min(1),
    state: z.literal("planned"),
    assetId: z.string().min(1),
    personaId: personaSchema,
    targetAiringId: z.string().min(1).optional(),
    scheduleRevision: z.string().min(1),
    plannedAt: z.string().datetime({ offset: true }),
    ...directorFields,
  }).strict(),
  z.object({
    id: z.string().min(1),
    state: z.literal("aired"),
    assetId: z.string().min(1),
    personaId: personaSchema,
    targetAiringId: z.string().min(1).optional(),
    airedAt: z.string().datetime({ offset: true }),
    ...directorFields,
  }).strict(),
]);

export type ContinuityDecision = z.infer<typeof decisionSchema>;

export type ContinuityHistoryQuery = {
  now?: string;
  maxAgeMs?: number;
  maxEntries?: number;
  /** Persist the filtered result after querying. */
  prune?: boolean;
};

const historyId = (channelId: string) => `continuity:${channelId}:history`;
const timestamp = (decision: ContinuityDecision) =>
  Date.parse(decision.state === "aired" ? decision.airedAt : decision.plannedAt);

/**
 * Reads only independently-valid history records. A corrupt setting or corrupt
 * record is treated as absent rather than becoming trusted scheduling input.
 */
function storedDecisions(repositories: Repositories, channelId: string): ContinuityDecision[] {
  const stored = repositories.settings.get(historyId(channelId))?.value;
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((value) => {
    const parsed = decisionSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

function bounded(
  decisions: ContinuityDecision[],
  options: ContinuityHistoryQuery,
): ContinuityDecision[] {
  const now = options.now ? Date.parse(options.now) : undefined;
  const maxAgeMs = options.maxAgeMs;
  const maxEntries = options.maxEntries;
  if (options.now && Number.isNaN(now)) throw new Error("Continuity history query now must be an ISO instant");
  if (maxAgeMs !== undefined && (!Number.isFinite(maxAgeMs) || maxAgeMs < 0))
    throw new Error("Continuity history maxAgeMs must be a nonnegative finite number");
  if (maxEntries !== undefined && (!Number.isInteger(maxEntries) || maxEntries < 0))
    throw new Error("Continuity history maxEntries must be a nonnegative integer");

  let result = [...decisions];
  if (now !== undefined && maxAgeMs !== undefined)
    result = result.filter((decision) => timestamp(decision) >= now - maxAgeMs);
  result.sort((left, right) => timestamp(left) - timestamp(right) || left.id.localeCompare(right.id));
  return maxEntries === undefined ? result : result.slice(-maxEntries);
}

/** Reads channel-scoped decisions, optionally applying a non-destructive retention view. */
export function readContinuityHistory(
  repositories: Repositories,
  channelId: string,
  options: ContinuityHistoryQuery = {},
): ContinuityDecision[] {
  const decisions = bounded(storedDecisions(repositories, channelId), options);
  if (options.prune) repositories.settings.put(historyId(channelId), decisions);
  return decisions;
}

/** Appends a decision once. Replaying the same decision id leaves storage unchanged. */
export function appendContinuityDecision(
  repositories: Repositories,
  channelId: string,
  decision: ContinuityDecision,
): ContinuityDecision {
  const validated = decisionSchema.parse(decision);
  const current = storedDecisions(repositories, channelId);
  const existing = current.find((entry) => entry.id === validated.id);
  if (existing) return existing;
  repositories.settings.put(historyId(channelId), [...current, validated]);
  return validated;
}

/** Removes only obsolete plans. Aired decisions remain available for cooldown checks. */
export function invalidatePlannedContinuityDecisions(
  repositories: Repositories,
  channelId: string,
  scheduleRevision: string,
): number {
  if (!scheduleRevision) throw new Error("Continuity history schedule revision is required");
  const current = storedDecisions(repositories, channelId);
  const retained = current.filter(
    (decision) => decision.state === "aired" || decision.scheduleRevision === scheduleRevision,
  );
  const invalidated = current.length - retained.length;
  if (invalidated) repositories.settings.put(historyId(channelId), retained);
  return invalidated;
}

/** Converts actual airings into the existing selection cooldown contract. */
export function readAiredContinuityHistory(
  repositories: Repositories,
  channelId: string,
  options: ContinuityHistoryQuery = {},
): ContinuityHistoryEntry[] {
  return readContinuityHistory(repositories, channelId, options)
    .filter((decision) => decision.state === "aired")
    .map((decision) => ({
      assetId: decision.assetId,
      targetAiringId: decision.targetAiringId,
      personaId: decision.personaId as ContinuityPersona,
      airedAt: decision.airedAt,
      state: "aired" as const,
      ...(decision.cardType ? { cardType: decision.cardType } : {}),
      ...(decision.targetKey ? { targetKey: decision.targetKey } : {}),
      ...(decision.family ? { family: decision.family } : {}),
    }));
}

export type PlanningHistoryQuery = {
  /** Insertion instant of the schedule being planned; nothing later counts. */
  before?: string;
  maxAgeMs?: number;
  /**
   * The generation currently being planned, whose own planned records must not
   * be counted: they have not been published yet, and counting them would make
   * regenerating the same day double-count its own insertions.
   */
  excludeScheduleRevision?: string;
};

/**
 * Cadence evidence for planning one schedule.
 *
 * A card is recorded as `planned` the moment it is published into a schedule,
 * so a *successful insertion* another generation made is real evidence for
 * cadence even before it airs. This reads those successful insertions together
 * with genuine airings, filtered so that nothing at or after the planning
 * instant can influence an earlier break, and never exposes planned records as
 * if they had aired.
 */
export function readContinuityHistoryForPlanning(
  repositories: Repositories,
  channelId: string,
  options: PlanningHistoryQuery = {},
): ContinuityHistoryEntry[] {
  const before = options.before === undefined ? undefined : Date.parse(options.before);
  if (before !== undefined && Number.isNaN(before))
    throw new Error("Continuity planning history before must be an ISO instant");
  const maxAgeMs = options.maxAgeMs;
  return readContinuityHistory(repositories, channelId)
    .flatMap((decision): ContinuityHistoryEntry[] => {
      if (
        options.excludeScheduleRevision &&
        decision.state === "planned" &&
        decision.scheduleRevision === options.excludeScheduleRevision
      )
        return [];
      const at = decision.state === "aired" ? decision.airedAt : decision.plannedAt;
      const time = Date.parse(at);
      if (!Number.isFinite(time)) return [];
      if (before !== undefined && time >= before) return [];
      if (maxAgeMs !== undefined && before !== undefined && time < before - maxAgeMs)
        return [];
      return [
        {
          assetId: decision.assetId,
          targetAiringId: decision.targetAiringId,
          personaId: decision.personaId as ContinuityPersona,
          airedAt: at,
          state: decision.state,
          ...(decision.cardType ? { cardType: decision.cardType } : {}),
          ...(decision.targetKey ? { targetKey: decision.targetKey } : {}),
          ...(decision.family ? { family: decision.family } : {}),
        },
      ];
    });
}
