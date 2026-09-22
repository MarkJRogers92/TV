import type {
  AirStatus,
  ApiError,
  Channel,
  ContinuityStatus,
  ContinuityUpdate,
  GeneratedSchedule,
  ImportSeasonResult,
  IntegrationProjection,
  IntegrationProvider,
  JobActionResult,
  MediaItem,
  MediaRoot,
  MovieProgrammingControl,
  MovieProgrammingStatus,
  NewWantedInput,
  NewWantedMovieInput,
  Pool,
  ScanResult,
  Schedule,
  SeasonPackView,
  WantedMovieView,
  WantedView,
} from "./types";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  // Fastify rejects a JSON content-type with an empty body (FST_ERR_CTP_EMPTY_JSON_BODY),
  // so only advertise JSON when the caller actually sends one.
  const jsonHeader =
    init?.body == null ? {} : { headers: { "content-type": "application/json" } };
  const response = await fetch(`/api/v1${path}`, {
    ...jsonHeader,
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
  continuityStatus: (channelId: string) =>
    api<ContinuityStatus>(
      `/channels/${encodeURIComponent(channelId)}/continuity`,
    ),
  updateContinuity: (channelId: string, input: ContinuityUpdate) =>
    api<ContinuityStatus>(
      `/channels/${encodeURIComponent(channelId)}/continuity`,
      update(input),
    ),
  /** Movie-programming control and its rolling preview. */
  movieProgrammingStatus: (channelId: string) =>
    api<MovieProgrammingStatus>(
      `/channels/${encodeURIComponent(channelId)}/movie-programming`,
    ),
  setMovieProgramming: (
    channelId: string,
    input: MovieProgrammingControl,
  ) =>
    api<Channel>(
      `/channels/${encodeURIComponent(channelId)}/movie-programming`,
      update(input),
    ),
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
  /**
   * The newest schedule for one broadcast date.
   *
   * `date` is optional so a caller can let the server answer for the channel's
   * current date, which is derived in the channel's timezone rather than the
   * browser's.
   */
  latestSchedule: (channelId: string, date?: string) =>
    api<Schedule | null>(
      `/schedules/latest?channelId=${encodeURIComponent(channelId)}${
        date ? `&date=${encodeURIComponent(date)}` : ""
      }`,
    ),
  generateSchedule: (channelId: string, date: string) =>
    api<GeneratedSchedule>("/schedules/generate", body({ channelId, date })),
  listWanted: () => api<WantedView[]>("/acquisitions/wanted"),
  addWanted: (input: NewWantedInput) =>
    api<WantedView>("/acquisitions/wanted", body(input)),
  removeWanted: (id: string) =>
    api<WantedView>(`/acquisitions/wanted/${id}`, { method: "DELETE" }),
  listWantedMovies: () => api<WantedMovieView[]>("/acquisitions/wanted-movies"),
  addWantedMovie: (input: NewWantedMovieInput) =>
    api<WantedMovieView>("/acquisitions/wanted-movies", body(input)),
  removeWantedMovie: (id: string) =>
    api<WantedMovieView>(`/acquisitions/wanted-movies/${id}`, { method: "DELETE" }),
  listSeasonPacks: () =>
    api<SeasonPackView[]>("/acquisitions/season-packs"),
  retryJob: (id: string) =>
    api<JobActionResult>(`/acquisitions/jobs/${id}/retry`, body({})),
  cancelJob: (id: string) =>
    api<JobActionResult>(`/acquisitions/jobs/${id}/cancel`, body({})),
  selectCandidate: (id: string, input: { candidateIndex: number; reviewUpdatedAt: string }) =>
    api<JobActionResult>(
      `/acquisitions/reviews/${encodeURIComponent(id)}/select-candidate`,
      body(input),
    ),
  importSeason: (id: string) =>
    api<ImportSeasonResult>(
      `/acquisitions/reviews/${encodeURIComponent(id)}/import-season`,
      body({}),
    ),
  /** Decline an offer without importing it. Removes only the offer row. */
  dismissReview: (id: string) =>
    api<{ dismissed: boolean; id: string }>(
      `/acquisitions/reviews/${encodeURIComponent(id)}/dismiss`,
      body({}),
    ),
  listIntegrations: () => api<IntegrationProjection[]>("/integrations"),
  saveIntegrationToken: (provider: IntegrationProvider, token: string) =>
    api<IntegrationProjection>(`/integrations/${provider}/token`, update({ token })),
  testIntegration: (provider: IntegrationProvider) =>
    api<IntegrationProjection>(`/integrations/${provider}/test`, body({})),
};

export type MarkTvApi = typeof markTvApi;
