import { realpathSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import {
  channelSchema,
  createdFillerSchema,
  fillerListSchema,
  fillerProgramSchema,
  healthSchema,
  programSchema,
  programmingSchema,
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
    try {
      return await this.fetcher(`${this.url}${path}`, init);
    } catch {
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

  async detect(channelId = "", libraryId = ""): Promise<TunarrCapabilities> {
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

    const [channels, fillers, transcodes, inventory, programming] =
      await Promise.all([
        this.request("/api/channels"),
        this.request("/api/filler-lists"),
        this.request("/api/transcode_configs"),
        libraryId
          ? this.request(
              `/api/media-libraries/${encodeURIComponent(libraryId)}/programs`,
            )
          : undefined,
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
    const supportsInventory = libraryId
      ? await schemaResponse(inventory, programSchema.array())
      : false;
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

  async inventory(libraryId: string): Promise<TunarrInventory> {
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
    const inventory: TunarrInventory = [];
    for (const entry of body) {
      const parsed = programSchema.safeParse(entry);
      if (!parsed.success)
        throw tunarrError(
          "UNSUPPORTED_SCHEMA",
          "Tunarr library response is unsupported",
        );
      for (const location of parsed.data.program.mediaItem?.locations ?? []) {
        if (location.type === "local") {
          inventory.push({
            id: parsed.data.id,
            path: normalizeLocalPath(location.path),
            program: parsed.data,
          });
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
    const capabilities = await this.detect(
      mapping.channelId,
      mapping.libraryId,
    );
    const [channels, fillerLists, transcodeConfigs, inventory] =
      await Promise.all([
        capabilities.supportsChannels ? this.getChannels() : [],
        capabilities.supportsFillerLists ? this.getFillerLists() : [],
        capabilities.supportsTranscodeConfigs ? this.getTranscodeConfigs() : [],
        capabilities.supportsInventory ? this.inventory(mapping.libraryId) : [],
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
