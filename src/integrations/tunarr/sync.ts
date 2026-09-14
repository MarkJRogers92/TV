import type { Schedule } from "../../domain/models.js";
import type { TunarrClient } from "./client.js";
import {
  buildTunarrSyncPlan,
  resolveFillerId,
  type TunarrSyncPlan,
} from "./plan.js";
import { tunarrError } from "./types.js";

type SyncClient = Pick<
  TunarrClient,
  | "snapshot"
  | "createChannel"
  | "putChannel"
  | "createFillerList"
  | "putFillerList"
  | "postProgramming"
>;

export async function syncTunarrPlan(
  client: SyncClient,
  plan: TunarrSyncPlan,
  currentSchedule: Schedule,
) {
  if (!plan.syncEligible || Date.now() - Date.parse(plan.createdAt) > 300_000) {
    throw tunarrError("STALE_DRY_RUN", "Dry run is stale or blocked");
  }
  const freshSnapshot = await client.snapshot(plan.mapping);
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
  const state: { channelId?: string; fillerListId?: string } = {
    channelId: plan.mapping.channelId,
    fillerListId: plan.mapping.fillerListId,
  };
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
