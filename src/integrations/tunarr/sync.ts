import { z } from "zod";
import type { Schedule } from "../../domain/models.js";
import type { TunarrClient } from "./client.js";
import { tunarrClientLimits } from "./client.js";
import {
  buildTunarrSyncPlan,
  resolveFillerId,
  type TunarrSyncPlan,
} from "./plan.js";
import { mediaSessionSchema, tunarrError } from "./types.js";

/**
 * Tunarr has served the session list as an array, as a map keyed by session
 * id, and (current builds) as a map from channel id to that channel's session
 * array. All three are accepted; every other body is refused rather than
 * silently treated as "nobody is watching".
 */
const sessionsSchema = z.union([
  mediaSessionSchema.array(),
  z.record(z.string(), mediaSessionSchema),
  z.record(z.string(), mediaSessionSchema.array()),
]);

type SyncClient = Pick<
  TunarrClient,
  | "snapshot"
  | "createChannel"
  | "putChannel"
  | "createFillerList"
  | "putFillerList"
  | "postProgramming"
> & {
  url: string;
  /**
   * Seam for tests that drive the guard without inventing HTTP responses. The
   * real client has no such method, so it goes through `activeSessionCount`.
   */
  activeSessionCount?: (channelId: string) => Promise<number>;
};

/**
 * Live connections watching one mapped channel, read from Tunarr's session
 * list.
 *
 * This lives here rather than on the client because the sync guard is the only
 * caller and it must fail closed: an unreadable or unrecognized session list
 * throws, and the sync refuses to mutate anything. A session whose channel
 * cannot be identified is counted rather than ignored - refusing a safe sync is
 * recoverable, interrupting a viewer is not.
 */
async function activeSessionCount(
  client: SyncClient,
  channelId: string,
): Promise<number> {
  if (client.activeSessionCount) return client.activeSessionCount(channelId);
  let response: Response;
  try {
    response = await fetch(`${client.url.replace(/\/$/, "")}/api/sessions`, {
      signal: AbortSignal.timeout(tunarrClientLimits.requestTimeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError")
      throw tunarrError(
        "TIMEOUT",
        `Tunarr did not respond within ${tunarrClientLimits.requestTimeoutMs}ms`,
      );
    throw tunarrError("UNREACHABLE", "Tunarr is unavailable");
  }
  if (!response.ok)
    throw tunarrError("SESSIONS_UNAVAILABLE", "Unable to read Tunarr sessions");
  const parsed = sessionsSchema.safeParse(await response.json());
  if (!parsed.success)
    throw tunarrError(
      "UNSUPPORTED_SCHEMA",
      "Tunarr sessions response is unsupported",
    );
  // Only the channel-keyed array shape carries attribution in its key; the
  // session-keyed map's key is a session id, so those entries stay unattributed
  // exactly as before.
  const entries: Array<{
    session: z.infer<typeof mediaSessionSchema>;
    mapKey?: string;
  }> = Array.isArray(parsed.data)
    ? parsed.data.map((session) => ({ session }))
    : Object.entries(parsed.data).flatMap(([mapKey, value]) =>
        Array.isArray(value)
          ? value.map((session) => ({ session, mapKey }))
          : [{ session: value }],
      );
  let active = 0;
  for (const { session, mapKey } of entries) {
    const sessionChannel =
      session.channelId ??
      session.channel_id ??
      (typeof session.channel === "string"
        ? session.channel
        : session.channel?.id) ??
      mapKey;
    if (sessionChannel !== undefined && sessionChannel !== channelId) continue;
    active += session.numConnections ?? 1;
  }
  return active;
}

export async function syncTunarrPlan(
  client: SyncClient,
  plan: TunarrSyncPlan,
  currentSchedule: Schedule,
) {
  if (!plan.syncEligible || Date.now() - Date.parse(plan.createdAt) > 300_000) {
    throw tunarrError("STALE_DRY_RUN", "Dry run is stale or blocked");
  }
  const freshSnapshot = await client.snapshot(plan.mapping);

  // Replacing an existing channel's lineup interrupts whoever is watching it.
  // Creating a channel cannot interrupt anyone, so only the mapped existing
  // channel is checked. This runs before the fingerprint comparison: a live
  // viewer is the one condition where Tunarr's own channel state is expected to
  // be moving, and it must surface as a retryable block rather than a stale
  // refusal. Either way nothing is mutated.
  const existingChannelId = plan.mapping.createChannel
    ? undefined
    : plan.mapping.channelId;
  if (
    existingChannelId &&
    (await activeSessionCount(client, existingChannelId)) > 0
  )
    throw tunarrError(
      "ACTIVE_VIEWERS",
      "The Tunarr channel has active viewers; try again after playback stops",
    );

  const fresh = buildTunarrSyncPlan(
    currentSchedule,
    freshSnapshot.inventory,
    freshSnapshot.capabilities,
    plan.mapping,
    freshSnapshot.snapshots,
  );
  if (fresh.fingerprint !== plan.fingerprint)
    throw tunarrError(
      "STALE_DRY_RUN",
      "Tunarr state changed since the dry run",
    );

  const completed: string[] = [];
  // Only defined values are recorded, so spreading this state over the stored
  // mapping can never erase a preserved id with `undefined`.
  const state: { channelId?: string; fillerListId?: string } = {};
  if (plan.mapping.channelId) state.channelId = plan.mapping.channelId;
  if (plan.mapping.fillerListId) state.fillerListId = plan.mapping.fillerListId;
  const failure = (error: unknown) => ({
    completed,
    partialFailure: true as const,
    error:
      error instanceof Error
        ? error.message
        : `HTTP ${(error as { status?: number }).status ?? "unknown"}`,
    state,
  });

  for (const operation of fresh.operations) {
    try {
      if (operation.type === "channel-create") {
        const created = await client.createChannel(operation.payload);
        state.channelId = created.id;
      } else if (operation.type === "channel-update") {
        const response = await client.putChannel(
          operation.channelId,
          operation.payload,
        );
        if (!response.ok) return failure({ status: response.status });
        state.channelId = operation.channelId;
      } else if (operation.type === "filler-create") {
        const created = await client.createFillerList(operation.payload);
        state.fillerListId = created.id;
      } else if (operation.type === "filler-update") {
        state.fillerListId = operation.fillerListId;
        const response = await client.putFillerList(
          operation.fillerListId,
          operation.payload,
        );
        if (!response.ok) return failure({ status: response.status });
      } else {
        if (!state.channelId)
          return failure(new Error("Tunarr channel ID was not resolved"));
        const lineup = state.fillerListId
          ? resolveFillerId(operation.payload, state.fillerListId)
          : operation.payload;
        const response = await client.postProgramming(state.channelId, lineup);
        if (!response.ok) return failure({ status: response.status });
      }
      completed.push(operation.type);
    } catch (error) {
      return failure(error);
    }
  }
  return { completed, partialFailure: false as const, state };
}
