import { z } from "zod";
import type { RemoteFile, RemoteItem } from "../../acquisition/providerTypes.js";
import {
  type AcquisitionProvider,
  type ProviderAccount,
  boundedProviderFetch,
  permanentError,
  readProviderJson,
  responseError,
  schemaError,
} from "./provider.js";

const envelope = <T extends z.ZodType>(schema: T) =>
  z.object({ success: z.literal(true), data: schema }).passthrough();
const accountSchema = envelope(
  z.object({ email: z.string().min(1).optional(), username: z.string().min(1).optional() }).passthrough(),
);
const torrentSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  name: z.string().min(1),
  download_finished: z.boolean(),
  updated_at: z.string().min(1).optional(),
  created_at: z.string().min(1).optional(),
  files: z.array(
    z.object({
      id: z.union([z.string(), z.number()]).transform(String),
      name: z.string().min(1),
      path: z.string().optional(),
      size: z.number().finite().nonnegative().optional(),
    }),
  ).nullable(),
});
const torrentListSchema = envelope(z.array(torrentSchema));
const requestDownloadSchema = envelope(
  z.union([z.string().url(), z.object({ url: z.string().url() }).passthrough()]),
);

export class TorBoxProvider implements AcquisitionProvider {
  readonly provider = "torbox" as const;
  private readonly baseUrl: string;

  constructor(
    baseUrl = "https://api.torbox.app",
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async request(path: string, token?: string, signal?: AbortSignal): Promise<Response> {
    const headers = new Headers();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return boundedProviderFetch(this.fetcher, `${this.baseUrl}${path}`, { method: "GET", headers }, signal);
  }

  private path(path: string, token: string, values: Record<string, string> = {}): string {
    const query = new URLSearchParams({ token, ...values });
    return `${path}?${query.toString()}`;
  }

  async testAuthentication(token: string, signal?: AbortSignal): Promise<ProviderAccount> {
    const response = await this.request("/v1/api/user/me", token, signal);
    if (!response.ok) throw responseError(response);
    const parsed = accountSchema.safeParse(await readProviderJson(response, signal));
    if (!parsed.success) throw schemaError();
    const label = parsed.data.data.email ?? parsed.data.data.username;
    if (!label) throw schemaError();
    return { label };
  }

  async listCompletedItems(token: string, signal?: AbortSignal): Promise<readonly RemoteItem[]> {
    const response = await this.request("/v1/api/torrents/mylist", token, signal);
    if (!response.ok) throw responseError(response);
    const parsed = torrentListSchema.safeParse(await readProviderJson(response, signal));
    if (!parsed.success) throw schemaError();
    return parsed.data.data.flatMap((torrent) => {
      if (torrent.download_finished !== true || torrent.files === null) return [];
      return [{
        provider: this.provider,
        itemType: "torrent" as const,
        remoteItemId: torrent.id,
        originalName: torrent.name,
        completedAt: torrent.updated_at ?? torrent.created_at ?? null,
        files: torrent.files.map((file) => ({
          provider: this.provider,
          itemType: "torrent" as const,
          remoteItemId: torrent.id,
          remoteFileId: file.id,
          originalFilename: file.name.split("/").filter(Boolean).at(-1) ?? file.name,
          remotePath: file.path ?? file.name,
          bytes: file.size ?? null,
        })),
      }];
    });
  }

  async requestDownloadUrl(token: string, locator: Pick<RemoteFile, "provider" | "itemType" | "remoteItemId" | "remoteFileId">, signal?: AbortSignal): Promise<string> {
    if (locator.provider !== this.provider || locator.itemType !== "torrent")
      throw permanentError("Provider locator does not belong to TorBox");
    const response = await this.request(
      this.path("/v1/api/torrents/requestdl", token, {
        torrent_id: locator.remoteItemId,
        file_id: locator.remoteFileId,
      }),
      undefined,
      signal,
    );
    if (!response.ok) throw responseError(response);
    const parsed = requestDownloadSchema.safeParse(await readProviderJson(response, signal));
    if (!parsed.success) throw schemaError();
    return typeof parsed.data.data === "string" ? parsed.data.data : parsed.data.data.url;
  }
}
