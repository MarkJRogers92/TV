import { realpathSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import {
  channelSchema,
  createdFillerSchema,
  fillerListSchema,
  fillerProgramSchema,
  healthSchema,
  normalizeLibraryIds,
  programSchema,
  programmingSchema,
  resolveLibraryIds,
  tunarrError,
  transcodeConfigSchema,
  versionSchema,
  type TunarrCapabilities,
  type TunarrChannel,
  type TunarrContentProgram,
  type TunarrFillerList,
  type TunarrInventory,
  type TunarrLineup,
  type TunarrMappingInput,
  type TunarrProgramming,
  type TunarrSnapshotResult,
  type TunarrTranscodeConfig,
} from "./types.js";

/**
 * Deadline for every request made to Tunarr.
 *
 * Every upstream call funnels through `TunarrClient.request()`, so this one value
 * bounds all of them. It exists because a Tunarr that accepts the connection and
 * then never answers does not fail `fetch` on its own: the calling route would wait
 * forever, holding its socket and handler. That is unrecoverable in practice,
 * because the app runs without a logger - there is nothing to notice it by.
 *
 * A mutable object rather than a constant so tests can shrink the deadline instead
 * of waiting it out, matching the `watchProxyLimits` convention.
 */
export const tunarrClientLimits = {
  requestTimeoutMs: 15_000,
};

export function normalizeLocalPath(path: string): string {
  if (!isAbsolute(path))
    throw tunarrError(
      "RELATIVE_MEDIA_PATH",
      "Tunarr media paths must be absolute",
    );
  try {
    return realpathSync.native(path);
  } catch {
    return normalize(path);
  }
}

export class TunarrClient {
  readonly url: string;

  constructor(
    url: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.url = url.replace(/\/$/, "");
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const timeout = AbortSignal.timeout(tunarrClientLimits.requestTimeoutMs);
    // Combine rather than overwrite: a caller-supplied signal (a client
    // disconnect, a shutdown) must still be able to abort ahead of the deadline.
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeout])
      : timeout;
    try {
      return await this.fetcher(`${this.url}${path}`, { ...init, signal });
    } catch (error) {
      // A timeout and a refused connection call for different responses, so they
      // are kept distinct: a timeout usually means a wedged or overloaded Tunarr,
      // while a refusal means the URL itself is wrong.
      if (error instanceof Error && error.name === "TimeoutError") {
        throw tunarrError(
          "TIMEOUT",
          `Tunarr did not respond within ${tunarrClientLimits.requestTimeoutMs}ms`,
        );
      }
      throw tunarrError("UNREACHABLE", "Tunarr is unavailable");
    }
  }

  private async jsonArray<T>(
    path: string,
    code: string,
    schema: { safeParse: (value: unknown) => { success: boolean; data?: T[] } },
  ): Promise<T[]> {
    const response = await this.request(path);
    if (!response.ok) throw tunarrError(code, `Unable to read ${path}`);
    const body: unknown = await response.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success)
      throw tunarrError(
        "UNSUPPORTED_SCHEMA",
        `${path} response is unsupported`,
      );
    return parsed.data!;
  }

  /**
   * Media sources, used to find which source owns a library. A library id is
   * not enough to scan it: Tunarr's scan route is addressed by source then
   * library, and only the source knows it holds the library.
   */
  async mediaSources(): Promise<Array<{ id: string; libraries?: Array<{ id: string }> }>> {
    const response = await this.request("/api/media-sources");
    if (!response.ok)
      throw tunarrError("UNREACHABLE", "Unable to read Tunarr media sources");
    const body: unknown = await response.json();
    return Array.isArray(body)
      ? (body as Array<{ id: string; libraries?: Array<{ id: string }> }>)
      : [];
  }

  /** Asks Tunarr to rescan one library. The scan itself runs asynchronously. */
  async scanLibrary(mediaSourceId: string, libraryId: string): Promise<boolean> {
    const response = await this.request(
      `/api/media-sources/${encodeURIComponent(mediaSourceId)}/libraries/${encodeURIComponent(libraryId)}/scan`,
      { method: "POST" },
    );
    return response.ok;
  }

  /** Whether Tunarr is still working through a library scan. */
  async isScanning(mediaSourceId: string, libraryId: string): Promise<boolean> {
    const response = await this.request(
      `/api/media-sources/${encodeURIComponent(mediaSourceId)}/${encodeURIComponent(libraryId)}/status`,
    );
    if (!response.ok) return false;
    const body = (await response.json()) as { state?: string };
    return body.state !== undefined && body.state !== "not_scanning";
  }

  async detect(
    channelId = "",
    libraryIdOrIds: string | string[] = "",
  ): Promise<TunarrCapabilities> {
    const health = await this.request("/api/system/health");
    if (!health.ok)
      throw tunarrError("UNREACHABLE", "Tunarr health check failed");
    const parsedHealth = healthSchema.safeParse(await health.json());
    if (!parsedHealth.success)
      throw tunarrError(
        "UNSUPPORTED_SCHEMA",
        "Tunarr health response is unsupported",
      );
    const healthy = Object.values(parsedHealth.data).every(
      (result) => result.type === "healthy",
    );
    const response = await this.request("/api/version");
    if (!response.ok) throw tunarrError("UNREACHABLE", "Tunarr is unavailable");
    const parsedVersion = versionSchema.safeParse(await response.json());
    if (!parsedVersion.success)
      throw tunarrError(
        "UNSUPPORTED_SCHEMA",
        "Tunarr version response is unsupported",
      );

    const libraryIds = normalizeLibraryIds(libraryIdOrIds);
    const [channels, fillers, transcodes, programming] = await Promise.all([
      this.request("/api/channels"),
      this.request("/api/filler-lists"),
      this.request("/api/transcode_configs"),
      channelId
        ? this.request(
            `/api/channels/${encodeURIComponent(channelId)}/programming`,
          )
        : undefined,
    ]);
    const schemaResponse = async (
      value: Response | undefined,
      schema: { safeParse: (body: unknown) => { success: boolean } },
    ) =>
      Boolean(
        value?.ok && schema.safeParse(await value.clone().json()).success,
      );
    const supportsChannels = await schemaResponse(
      channels,
      channelSchema.array(),
    );
    const supportsFillerLists = await schemaResponse(
      fillers,
      fillerListSchema.array(),
    );
    const supportsTranscodeConfigs = await schemaResponse(
      transcodes,
      transcodeConfigSchema.array(),
    );
    let supportsInventory = false;
    if (libraryIds.length) {
      const libraryResponses = await Promise.all(
        libraryIds.map((id) =>
          this.request(
            `/api/media-libraries/${encodeURIComponent(id)}/programs`,
          ),
        ),
      );
      supportsInventory = true;
      for (const inventoryResponse of libraryResponses) {
        if (!(await schemaResponse(inventoryResponse, programSchema.array()))) {
          supportsInventory = false;
          break;
        }
      }
    }
    let supportsProgramming = supportsChannels && !channelId;
    if (programming?.ok) {
      const parsed = programmingSchema.safeParse(await programming.json());
      if (!parsed.success)
        throw tunarrError(
          "UNSUPPORTED_SCHEMA",
          "Tunarr programming response is unsupported",
        );
      supportsProgramming = true;
    }
    return {
      url: this.url,
      version: parsedVersion.data.tunarr,
      healthy,
      supportsChannels,
      supportsFillerLists,
      supportsTranscodeConfigs,
      supportsInventory,
      supportsProgramming,
    };
  }

  async inventory(
    libraryIdOrIds: string | string[],
  ): Promise<TunarrInventory> {
    const libraryIds = normalizeLibraryIds(libraryIdOrIds);
    if (!libraryIds.length)
      throw tunarrError(
        "INVENTORY_UNAVAILABLE",
        "No Tunarr library was requested",
      );
    const inventory: TunarrInventory = [];
    for (const libraryId of libraryIds) {
      const body = await this.jsonArray<unknown>(
        `/api/media-libraries/${encodeURIComponent(libraryId)}/programs`,
        "INVENTORY_UNAVAILABLE",
        {
          safeParse: (value) => ({
            success: Array.isArray(value),
            data: Array.isArray(value) ? value : undefined,
          }),
        },
      );
      for (const entry of body) {
        const parsed = programSchema.safeParse(entry);
        if (!parsed.success)
          throw tunarrError(
            "UNSUPPORTED_SCHEMA",
            "Tunarr library response is unsupported",
          );
        const locations = parsed.data.program.mediaItem?.locations;
        if (locations !== undefined) {
          for (const location of locations) {
            if (location.type === "local") {
              inventory.push({
                id: parsed.data.id,
                path: normalizeLocalPath(location.path),
                program: parsed.data,
              });
            }
          }
        } else {
          const externalId = (
            parsed.data.program as unknown as { externalId?: unknown }
          ).externalId;
          const sourceType = (
            parsed.data.program as unknown as { sourceType?: unknown }
          ).sourceType;
          if (
            sourceType === "local" &&
            typeof externalId === "string" &&
            externalId.length
          ) {
            inventory.push({
              id: parsed.data.id,
              path: normalizeLocalPath(externalId),
              program: parsed.data,
            });
          }
        }
      }
    }
    return inventory;
  }

  getChannels() {
    return this.jsonArray<TunarrChannel>(
      "/api/channels",
      "CHANNELS_UNAVAILABLE",
      {
        safeParse: (value) => {
          const parsed = channelSchema.array().safeParse(value);
          return parsed;
        },
      },
    );
  }

  getFillerLists() {
    return this.jsonArray<TunarrFillerList>(
      "/api/filler-lists",
      "FILLER_LISTS_UNAVAILABLE",
      fillerListSchema.array(),
    );
  }

  getFillerPrograms(id: string) {
    return this.jsonArray<TunarrContentProgram>(
      `/api/filler-lists/${encodeURIComponent(id)}/programs`,
      "FILLER_LISTS_UNAVAILABLE",
      fillerProgramSchema.array(),
    );
  }

  getTranscodeConfigs() {
    return this.jsonArray<TunarrTranscodeConfig>(
      "/api/transcode_configs",
      "TRANSCODE_CONFIGS_UNAVAILABLE",
      transcodeConfigSchema.array(),
    );
  }

  async getProgramming(channelId: string): Promise<TunarrProgramming> {
    const response = await this.request(
      `/api/channels/${encodeURIComponent(channelId)}/programming`,
    );
    if (!response.ok)
      throw tunarrError(
        "PROGRAMMING_UNAVAILABLE",
        "Unable to read Tunarr channel programming",
      );
    const parsed = programmingSchema.safeParse(await response.json());
    if (!parsed.success)
      throw tunarrError(
        "UNSUPPORTED_SCHEMA",
        "Tunarr programming response is unsupported",
      );
    return parsed.data;
  }

  async snapshot(mapping: TunarrMappingInput): Promise<TunarrSnapshotResult> {
    const libraryIds = resolveLibraryIds(mapping);
    const capabilities = await this.detect(mapping.channelId ?? "", libraryIds);
    const [channels, fillerLists, transcodeConfigs, inventory] =
      await Promise.all([
        capabilities.supportsChannels ? this.getChannels() : [],
        capabilities.supportsFillerLists ? this.getFillerLists() : [],
        capabilities.supportsTranscodeConfigs ? this.getTranscodeConfigs() : [],
        capabilities.supportsInventory ? this.inventory(libraryIds) : [],
      ]);
    const fillerPrograms = Object.fromEntries(
      await Promise.all(
        fillerLists.map(async (list) => [
          list.id,
          await this.getFillerPrograms(list.id),
        ]),
      ),
    );
    const programming =
      mapping.channelId && capabilities.supportsProgramming
        ? await this.getProgramming(mapping.channelId)
        : undefined;
    return {
      capabilities,
      inventory,
      snapshots: {
        channels,
        fillerLists,
        fillerPrograms,
        transcodeConfigs,
        programming,
      },
    };
  }

  async createChannel(payload: unknown): Promise<{ id: string }> {
    const response = await this.request("/api/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok)
      throw tunarrError("CHANNEL_CREATE_FAILED", `HTTP ${response.status}`);
    const body = channelSchema.safeParse(await response.json());
    if (!body.success)
      throw tunarrError(
        "UNSUPPORTED_SCHEMA",
        "Created channel response is unsupported",
      );
    return { id: body.data.id };
  }

  async putChannel(channelId: string, payload: unknown) {
    const response = await this.request(
      `/api/channels/${encodeURIComponent(channelId)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    if (!response.ok) return response;
    if (!channelSchema.safeParse(await response.json()).success)
      throw tunarrError(
        "UNSUPPORTED_SCHEMA",
        "Updated channel response is unsupported",
      );
    return response;
  }

  async createFillerList(payload: unknown): Promise<{ id: string }> {
    const response = await this.request("/api/filler-lists", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok)
      throw tunarrError("FILLER_CREATE_FAILED", `HTTP ${response.status}`);
    const body = createdFillerSchema.safeParse(await response.json());
    if (!body.success)
      throw tunarrError(
        "UNSUPPORTED_SCHEMA",
        "Created filler response has no id",
      );
    return { id: body.data.id };
  }

  async putFillerList(id: string, payload: unknown) {
    const response = await this.request(
      `/api/filler-lists/${encodeURIComponent(id)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    if (!response.ok) return response;
    if (!fillerListSchema.safeParse(await response.json()).success)
      throw tunarrError(
        "UNSUPPORTED_SCHEMA",
        "Updated filler response is unsupported",
      );
    return response;
  }

  async postProgramming(channelId: string, lineup: TunarrLineup) {
    const response = await this.request(
      `/api/channels/${encodeURIComponent(channelId)}/programming`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "manual", lineup, append: false }),
      },
    );
    if (!response.ok) return response;
    if (!programmingSchema.safeParse(await response.json()).success)
      throw tunarrError(
        "UNSUPPORTED_SCHEMA",
        "Programming response is unsupported",
      );
    return response;
  }
}
