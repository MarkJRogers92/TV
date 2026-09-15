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

const torrentSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  filename: z.string().min(1),
  status: z.string(),
  added: z.string().optional(),
  ended: z.string().optional(),
});
const torrentListSchema = z.array(torrentSchema);
const torrentInfoSchema = torrentSchema.extend({
  files: z.array(
    z.object({
      id: z.union([z.string(), z.number()]).transform(String),
      path: z.string(),
      bytes: z.number().finite().nonnegative().optional(),
      selected: z.union([z.number(), z.boolean()]).optional(),
    }),
  ),
  links: z.array(z.string().url()),
});
const accountSchema = z
  .object({ username: z.string().min(1) })
  .passthrough();
const unrestrictSchema = z.object({ download: z.string().url() }).passthrough();

export class RealDebridProvider implements AcquisitionProvider {
  readonly provider = "real-debrid" as const;
  private readonly baseUrl: string;

  constructor(
    baseUrl = "https://api.real-debrid.com/rest/1.0",
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async request(path: string, token: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return boundedProviderFetch(this.fetcher, `${this.baseUrl}${path}`, { ...init, headers }, signal);
  }

  async testAuthentication(token: string, signal?: AbortSignal): Promise<ProviderAccount> {
    const response = await this.request("/user", token, {}, signal);
    if (!response.ok) throw responseError(response);
    const parsed = accountSchema.safeParse(await readProviderJson(response, signal));
    if (!parsed.success) throw schemaError();
    return { label: parsed.data.username };
  }

  async listCompletedItems(token: string, signal?: AbortSignal): Promise<readonly RemoteItem[]> {
    const results: RemoteItem[] = [];
    const pageSize = 100;
    for (let page = 1; ; page += 1) {
      const response = await this.request(`/torrents?page=${page}&limit=${pageSize}`, token, {}, signal);
      if (!response.ok) throw responseError(response);
      const parsed = torrentListSchema.safeParse(await readProviderJson(response, signal));
      if (!parsed.success) throw schemaError();
      for (const torrent of parsed.data) {
        if (torrent.status !== "downloaded") continue;
        const completed = await this.completedItem(token, torrent.id, signal);
        if (completed) results.push(completed);
      }
      if (parsed.data.length < pageSize) return results;
    }
  }

  private async completedItem(token: string, itemId: string, signal?: AbortSignal): Promise<RemoteItem | null> {
    const response = await this.request(`/torrents/info/${encodeURIComponent(itemId)}`, token, {}, signal);
    if (!response.ok) throw responseError(response);
    const parsed = torrentInfoSchema.safeParse(await readProviderJson(response, signal));
    if (!parsed.success || parsed.data.status !== "downloaded") throw schemaError();
    const selected = parsed.data.files.filter(
      (file) => file.selected === 1 || file.selected === true,
    );
    // Old or partially unavailable Real-Debrid records can retain selected
    // file metadata after one or more corresponding links disappear. There is
    // no safe way to infer which remaining link belongs to which file, so omit
    // that individual record instead of blocking all otherwise usable items.
    if (parsed.data.links.length !== selected.length) return null;
    const files: RemoteFile[] = selected
      .map((file) => ({
        provider: this.provider,
        itemType: "torrent",
        remoteItemId: parsed.data.id,
        remoteFileId: file.id,
        originalFilename: file.path.split("/").filter(Boolean).at(-1) ?? file.path,
        // Real-Debrid roots provider-relative paths with `/`. Remove only that
        // API marker; the filename parser still rejects traversal segments and
        // all other unsafe path forms before a candidate can be matched.
        remotePath: file.path.replace(/^\//, ""),
        bytes: file.bytes ?? null,
      }));
    return {
      provider: this.provider,
      itemType: "torrent",
      remoteItemId: parsed.data.id,
      originalName: parsed.data.filename,
      completedAt: parsed.data.ended ?? parsed.data.added ?? null,
      files,
    };
  }

  async requestDownloadUrl(token: string, locator: Pick<RemoteFile, "provider" | "itemType" | "remoteItemId" | "remoteFileId">, signal?: AbortSignal): Promise<string> {
    if (locator.provider !== this.provider || locator.itemType !== "torrent")
      throw permanentError("Provider locator does not belong to Real-Debrid");
    const infoResponse = await this.request(`/torrents/info/${encodeURIComponent(locator.remoteItemId)}`, token, {}, signal);
    if (!infoResponse.ok) throw responseError(infoResponse);
    const info = torrentInfoSchema.safeParse(await readProviderJson(infoResponse, signal));
    if (!info.success || info.data.status !== "downloaded") throw schemaError();
    const selected = info.data.files.filter((file) => file.selected === 1 || file.selected === true);
    if (info.data.links.length !== selected.length) throw schemaError();
    const selectedIndex = selected.findIndex((file) => file.id === locator.remoteFileId);
    if (selectedIndex < 0 || !info.data.links[selectedIndex])
      throw permanentError();
    const response = await this.request("/unrestrict/link", token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ link: info.data.links[selectedIndex] }),
    }, signal);
    if (!response.ok) throw responseError(response);
    const parsed = unrestrictSchema.safeParse(await readProviderJson(response, signal));
    if (!parsed.success) throw schemaError();
    return parsed.data.download;
  }
}
