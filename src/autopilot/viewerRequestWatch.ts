/**
 * Observe whether real Tunarr viewers continue asking for stream data.
 *
 * This reads only Tunarr's metadata-only `/api/sessions` endpoint and the local
 * producer playlist's modification time. It never requests a master playlist,
 * media playlist, or segment, and it never attempts recovery. A request gap can
 * mean buffering, a paused app, or a closed app; it is not proof that the TV is
 * displaying a frozen picture.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Repositories } from "../db/repositories.js";

export type ViewerRequestAlert = {
  condition: "viewer-request-stalled" | "recovered";
  channelId: string;
  detail: string;
};

export type ViewerRequestWatchOptions = {
  /** Resolve the local producer directory for the MarkTV channel. */
  streamsDirectoryFor?: (channel: { id: string }) => string | null;
  /** Resolve the metadata-only Tunarr sessions endpoint for the channel. */
  sessionsUrlFor?: (channelId: string) => string | null;
  /** Resolve the Tunarr ID used to attribute sessions back to this channel. */
  tunarrChannelIdFor?: (channelId: string) => string | null;
  intervalMs?: number;
  /** Heartbeat age beyond which an observed viewer is considered stalled. */
  heartbeatStaleMs?: number;
  requestTimeoutMs?: number;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  /** Test seam; production reads only the local `stream.m3u8` file stat. */
  producerModifiedAt?: (path: string) => Promise<number>;
  onAlert?: (alert: ViewerRequestAlert) => void;
  onError?: (error: unknown, channelId?: string) => void;
};

export type ViewerRequestWatch = {
  start(): Promise<void>;
  stop(): Promise<void>;
  runOnce(): Promise<void>;
};

const connectionSchema = z
  .object({
    ip: z.string().optional(),
    userAgent: z.string().optional(),
    lastHeartbeat: z.union([z.number(), z.string()]).optional(),
  })
  .passthrough();

const sessionSchema = z
  .object({
    numConnections: z.number().nonnegative().optional(),
    connections: z.array(connectionSchema).optional(),
    channelId: z.string().optional(),
    channel_id: z.string().optional(),
    channel: z
      .union([
        z.string(),
        z.object({ id: z.string().optional() }).passthrough(),
      ])
      .optional(),
  })
  .passthrough();

// Tunarr has exposed sessions as a list, a session-keyed map, and a
// channel-keyed map. Unsupported responses are errors, never treated as an
// empty list (which could otherwise turn a schema change into a false recovery).
const sessionsSchema = z.union([
  sessionSchema.array(),
  z.record(z.string(), sessionSchema),
  z.record(z.string(), sessionSchema.array()),
]);

type SessionEntry = {
  session: z.infer<typeof sessionSchema>;
  mapKey?: string;
};

type ViewerState = {
  channelId: string;
  userAgent?: string;
  observedFresh: boolean;
  stalledAtMs?: number;
};

function flattenSessions(value: unknown): SessionEntry[] {
  const parsed = sessionsSchema.safeParse(value);
  if (!parsed.success) throw new Error("Tunarr sessions response is unsupported");
  if (Array.isArray(parsed.data)) {
    return parsed.data.map((session) => ({ session }));
  }
  return Object.entries(parsed.data).flatMap(([mapKey, value]) =>
    Array.isArray(value)
      ? value.map((session) => ({ session, mapKey }))
      : [{ session: value }],
  );
}

function sessionChannelId(session: SessionEntry["session"], mapKey?: string) {
  return (
    session.channelId ??
    session.channel_id ??
    (typeof session.channel === "string"
      ? session.channel
      : session.channel?.id) ??
    mapKey
  );
}

function heartbeatMs(value: number | string | undefined): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : null;
}

function isMarkTvAutomation(userAgent: string | undefined) {
  return /^marktv-(?:always-on|playout-watch|viewer-request-watch)\/\d+(?:\.\d+)*(?:\s|$)/i.test(
    userAgent ?? "",
  );
}

function describeViewer(userAgent: string | undefined) {
  if (userAgent && /tivimate/i.test(userAgent)) return "TiviMate";
  return userAgent ? "Viewer app" : "Unidentified viewer";
}

export function createViewerRequestWatch(
  repositories: Repositories,
  options: ViewerRequestWatchOptions = {},
): ViewerRequestWatch {
  const intervalMs = options.intervalMs ?? 10_000;
  const heartbeatStaleMs = options.heartbeatStaleMs ?? 25_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 2_000;
  const now = options.now ?? (() => new Date());
  const fetchImpl = options.fetchImpl ?? fetch;
  const producerModifiedAt =
    options.producerModifiedAt ??
    (async (path: string) => (await stat(path)).mtimeMs);
  const onAlert = options.onAlert ?? (() => undefined);
  const onError = options.onError ?? (() => undefined);
  const viewers = new Map<string, ViewerState>();
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let started = false;
  let stopping = false;

  const schedule = () => {
    if (stopping || !started || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void runOnce();
    }, intervalMs);
    timer.unref();
  };

  const pass = async () => {
    const channels = repositories.channels
      .list()
      .filter((channel) => channel.enabled)
      .flatMap((channel) => {
        const sessionsUrl = options.sessionsUrlFor?.(channel.id) ?? null;
        const tunarrChannelId =
          options.tunarrChannelIdFor?.(channel.id) ?? null;
        const directory = options.streamsDirectoryFor?.(channel) ?? null;
        return sessionsUrl && tunarrChannelId && directory
          ? [{ channelId: channel.id, tunarrChannelId, sessionsUrl, directory }]
          : [];
      });

    // Usually all channels share one Tunarr server, so one metadata request
    // covers all of them. Grouping also supports installations with more than
    // one configured Tunarr server without duplicate calls.
    const byUrl = new Map<string, typeof channels>();
    for (const channel of channels) {
      const group = byUrl.get(channel.sessionsUrl) ?? [];
      group.push(channel);
      byUrl.set(channel.sessionsUrl, group);
    }

    const checkedAtMs = now().getTime();
    for (const [url, group] of byUrl) {
      let entries: SessionEntry[];
      try {
        const response = await fetchImpl(url, {
          signal: AbortSignal.timeout(requestTimeoutMs),
          headers: { "user-agent": "marktv-viewer-request-watch/1.0" },
        });
        if (!response.ok) {
          throw new Error(`Tunarr sessions endpoint returned ${response.status}`);
        }
        entries = flattenSessions(await response.json());
      } catch (error) {
        for (const channel of group) onError(error, channel.channelId);
        continue;
      }

      for (const channel of group) {
        const seen = new Set<string>();
        let producerAgeMs: number | null = null;
        try {
          const modifiedAt = await producerModifiedAt(
            join(channel.directory, "stream.m3u8"),
          );
          producerAgeMs = Math.max(0, checkedAtMs - modifiedAt);
        } catch (error) {
          onError(error, channel.channelId);
        }

        for (const { session, mapKey } of entries) {
          if (
            sessionChannelId(session, mapKey) !== channel.tunarrChannelId &&
            sessionChannelId(session, mapKey) !== channel.channelId
          )
            continue;
          for (const [index, connection] of (session.connections ?? []).entries()) {
            const userAgent = connection.userAgent;
            if (isMarkTvAutomation(userAgent)) continue;
            const lastHeartbeatMs = heartbeatMs(connection.lastHeartbeat);
            if (lastHeartbeatMs === null) continue;
            const identity = connection.ip ?? `${userAgent ?? "unknown"}-${index}`;
            const key = `${channel.channelId}\u001f${identity}\u001f${userAgent ?? ""}`;
            seen.add(key);
            let state = viewers.get(key);
            if (!state) {
              state = {
                channelId: channel.channelId,
                ...(userAgent ? { userAgent } : {}),
                observedFresh: false,
              };
              viewers.set(key, state);
            }
            const ageMs = checkedAtMs - lastHeartbeatMs;
            const fresh = ageMs >= -60_000 && ageMs <= heartbeatStaleMs;
            if (fresh) {
              state.observedFresh = true;
              if (state.stalledAtMs !== undefined) {
                const gapSeconds = Math.max(
                  1,
                  Math.round((checkedAtMs - state.stalledAtMs) / 1_000),
                );
                onAlert({
                  condition: "recovered",
                  channelId: channel.channelId,
                  detail: `${describeViewer(state.userAgent)} requests resumed after about ${gapSeconds} seconds. This confirms requests resumed, not that the TV picture recovered.`,
                });
                delete state.stalledAtMs;
              }
            } else if (
              state.observedFresh &&
              state.stalledAtMs === undefined &&
              ageMs > heartbeatStaleMs
            ) {
              state.stalledAtMs = checkedAtMs;
              const producerDetail =
                producerAgeMs === null
                  ? "The producer playlist timestamp is unavailable."
                  : `The producer playlist was last updated about ${Math.round(producerAgeMs / 1_000)} seconds ago.`;
              onAlert({
                condition: "viewer-request-stalled",
                channelId: channel.channelId,
                detail: `${describeViewer(state.userAgent)} has not requested playback data for about ${Math.round(ageMs / 1_000)} seconds. ${producerDetail} This is a viewer request gap, not proof of a frozen picture; paused or closed apps can look the same.`,
              });
            }
          }
        }

        // A session disappearing ends the observation. Clear any outstanding
        // alert but say explicitly that disappearance is not proof of recovery.
        for (const [key, state] of viewers) {
          if (state.channelId !== channel.channelId || seen.has(key)) continue;
          if (state.stalledAtMs !== undefined) {
            onAlert({
              condition: "recovered",
              channelId: channel.channelId,
              detail: `${describeViewer(state.userAgent)} session ended and its alert was cleared. Playback recovery is unknown.`,
            });
          }
          viewers.delete(key);
        }
      }
    }
  };

  const runOnce = async () => {
    if (stopping) return;
    if (inFlight) return inFlight;
    inFlight = pass()
      .catch((error) => onError(error))
      .finally(() => {
        inFlight = undefined;
        schedule();
      });
    return inFlight;
  };

  return {
    async start() {
      if (started || stopping) return;
      started = true;
      await runOnce();
    },
    async stop() {
      stopping = true;
      started = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await inFlight;
    },
    runOnce,
  };
}
