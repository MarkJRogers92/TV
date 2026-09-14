import type {
  AirStatus,
  ApiError,
  Channel,
  GeneratedSchedule,
  MediaItem,
  MediaRoot,
  Pool,
  ScanResult,
  Schedule,
} from "./types";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    const payload = (await response
      .json()
      .catch(() => ({ message: response.statusText }))) as {
      code?: string;
      message?: string;
      issues?: ApiError["issues"];
    };
    throw Object.assign(
      new Error(payload.message ?? "MarkTV request failed"),
      payload,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const body = (value: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(value),
});
const update = (value: unknown): RequestInit => ({
  method: "PUT",
  body: JSON.stringify(value),
});

export const markTvApi = {
  listChannels: () => api<Channel[]>("/channels"),
  getChannel: (id: string) => api<Channel>(`/channels/${id}`),
  createChannel: (channel: Channel) => api<Channel>("/channels", body(channel)),
  updateChannel: (channel: Channel) =>
    api<Channel>(`/channels/${channel.id}`, update(channel)),
  getAir: (id: string) => api<AirStatus>(`/channels/${id}/air`),
  listMedia: () => api<MediaItem[]>("/media"),
  updateMedia: (item: MediaItem) =>
    api<MediaItem>(`/media/${item.id}`, update(item)),
  listMediaRoots: () => api<MediaRoot[]>("/media/roots"),
  addMediaRoot: (path: string) =>
    api<MediaRoot>("/media/roots", body({ path })),
  removeMediaRoot: (id: string) =>
    api<void>(`/media/roots/${id}`, { method: "DELETE" }),
  scanMediaRoot: (id: string) =>
    api<ScanResult>(`/media/roots/${id}/scan`, { method: "POST" }),
  listPools: () => api<Pool[]>("/pools"),
  createPool: (pool: Pool) => api<Pool>("/pools", body(pool)),
  updatePool: (pool: Pool) => api<Pool>(`/pools/${pool.id}`, update(pool)),
  removePool: (id: string) => api<void>(`/pools/${id}`, { method: "DELETE" }),
  latestSchedule: (channelId: string) =>
    api<Schedule | null>(
      `/schedules/latest?channelId=${encodeURIComponent(channelId)}`,
    ),
  generateSchedule: (channelId: string, date: string) =>
    api<GeneratedSchedule>("/schedules/generate", body({ channelId, date })),
};

export type MarkTvApi = typeof markTvApi;
