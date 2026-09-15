import { constants } from "node:fs";
import { lstat, open, statfs } from "node:fs/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { basename } from "node:path";
import type { AcquisitionProvider } from "../integrations/acquisition/provider.js";
import type { ProviderName, RemoteItemType } from "./providerTypes.js";
import {
  assertManagedDirectory,
  containedPath,
  ManagedPathError,
  type ManagedDirectoryIdentity,
} from "./paths.js";
import { type DnsLookup, type ValidatedRemoteUrl, validateRemoteUrl } from "./remoteUrl.js";

export interface DownloadJobInput {
  readonly id: string;
  readonly provider: ProviderName;
  readonly itemType: RemoteItemType;
  readonly remoteItemId: string;
  readonly remoteFileId: string;
  readonly receivedBytes: number;
  readonly expectedBytes: number | null;
}
export interface DownloadHooks {
  readonly inbox: string;
  /** Startup-captured inode identity; production callers must supply it. */
  readonly inboxIdentity?: ManagedDirectoryIdentity;
  onProgress?: (receivedBytes: number, expectedBytes: number | null) => void | Promise<void>;
  hasFreeBytes?: (neededBytes: number) => Promise<boolean>;
  sleep?: (milliseconds: number) => Promise<void>;
}
export interface DownloadRequest { readonly url: URL; readonly address: string; readonly headers: Record<string, string>; readonly signal?: AbortSignal; }
export interface DownloadResponse { readonly status: number; readonly headers: Headers; readonly body: ReadableStream<Uint8Array> | null; }
export type DownloadTransport = (request: DownloadRequest) => Promise<DownloadResponse>;
export interface PinnedHttpsRequestOptions {
  readonly hostname: string;
  readonly port: string;
  readonly path: string;
  readonly servername: string;
  readonly headers: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly lookup: LookupFunction;
}
export type PinnedHttpsRequest = (options: PinnedHttpsRequestOptions) => Promise<DownloadResponse>;
export interface DownloadOptions { readonly dnsLookup?: DnsLookup; readonly transport?: DownloadTransport; readonly maxRedirects?: number; readonly now?: () => number; }

/**
 * Stable download failure vocabulary. Cancellation and environment problems
 * (disk space, unsafe responses, permanent rejection) are never retried
 * automatically; an expired capability and a temporary service failure are,
 * and a temporary failure carries the provider's bounded `retryAfterMs` when
 * one was advertised. Callers branch on `code`/`retryable`, never on message
 * text, and a message never contains a URL or token.
 */
export const downloadErrorCodes = [
  "CANCELLED",
  "INSUFFICIENT_SPACE",
  "CAPABILITY_EXPIRED",
  "TEMPORARY_SERVICE_FAILURE",
  "UNSAFE_DOWNLOAD",
  "PERMANENT_REJECTION",
] as const;
export type DownloadErrorCode = (typeof downloadErrorCodes)[number];

export class DownloadError extends Error {
  readonly name = "DownloadError";

  constructor(
    readonly code: DownloadErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** An aborted transfer surfaces the typed cancellation category, not a DOMException. */
function cancelled(): DownloadError {
  return new DownloadError("CANCELLED", "Download cancelled", false);
}

/** Unsafe partials, ranges, redirects, and responses are never retried as-is. */
function unsafe(message: string): DownloadError {
  return new DownloadError("UNSAFE_DOWNLOAD", message, false);
}

/**
 * Raw transport rejections — DNS lookup and socket errors — are transient
 * outages, not permanent verdicts about the download. `responseFor()` maps
 * exactly these codes onto the retryable temporary-service category so the
 * coordinator's existing typed failure mapping schedules bounded backoff
 * instead of parking the job in Needs review.
 */
const transientTransportCodes = new Set([
  "EAI_AGAIN",
  "EAI_FAIL",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
]);

/** Never blanket-converts: typed failures and unknown errors pass through. */
function retryableTransportFailure(error: unknown): DownloadError | null {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === "string" && transientTransportCodes.has(code)
    ? new DownloadError("TEMPORARY_SERVICE_FAILURE", "Download service is temporarily unavailable", true)
    : null;
}

const nativePinnedRequest: PinnedHttpsRequest = (options) => new Promise((resolve, reject) => {
  const requestOptions: RequestOptions = {
    protocol: "https:", hostname: options.hostname, port: options.port || undefined,
    path: options.path, method: "GET", headers: options.headers,
    servername: options.servername, lookup: options.lookup as RequestOptions["lookup"], signal: options.signal,
  };
  const request = httpsRequest(requestOptions, (response) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    resolve({ status: response.statusCode ?? 0, headers, body: Readable.toWeb(response) as ReadableStream<Uint8Array> });
  });
  request.once("error", reject);
  request.end();
});

/** Production transport: TLS/SNI stays on the original hostname, but socket DNS is pinned. */
export function createPinnedHttpsTransport(requester: PinnedHttpsRequest = nativePinnedRequest): DownloadTransport {
  return async (request) => {
    const hostname = request.url.hostname.replace(/^\[|\]$/g, "");
    return requester({
    hostname, port: request.url.port,
    path: `${request.url.pathname}${request.url.search}`, servername: hostname,
    headers: { Host: request.url.host, Accept: "*/*", "Accept-Encoding": "identity", ...request.headers }, signal: request.signal,
    lookup: (_hostname, options, callback) => {
      const family = isIP(request.address);
      callback(
        null,
        options.all ? [{ address: request.address, family }] : request.address,
        family,
      );
    },
    });
  };
}

function isRedirect(status: number): boolean { return status === 301 || status === 302 || status === 303 || status === 307 || status === 308; }
function retryableStatus(status: number): boolean { return status === 408 || status === 429 || status >= 500; }
function retryDelay(response: DownloadResponse, attempt: number, now: () => number): number {
  const raw = response.headers.get("retry-after");
  const numeric = raw === null ? Number.NaN : Number(raw);
  const milliseconds = Number.isFinite(numeric) && numeric >= 0 ? numeric * 1_000 : Math.max(0, Date.parse(raw ?? "") - now());
  return Math.min(Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 250 * (attempt + 1), 5_000);
}
function contentLength(response: DownloadResponse): number | null { const value = Number(response.headers.get("content-length")); return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function parsedContentRange(response: DownloadResponse): { start: number; end: number; total: number } | null {
  const match = response.headers.get("content-range")?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (!match) return null;
  const [start, end, total] = match.slice(1).map(Number);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && Number.isSafeInteger(total) && start <= end && end < total ? { start, end, total } : null;
}
async function defaultSpace(path: string, bytes: number): Promise<boolean> { const stats = await statfs(path); return Number(stats.bavail) * Number(stats.bsize) >= bytes; }

async function assertInbox(hooks: DownloadHooks): Promise<void> {
  if (!hooks.inboxIdentity) return;
  try {
    await assertManagedDirectory(hooks.inboxIdentity);
  } catch (error) {
    if (error instanceof ManagedPathError) throw unsafe("Managed inbox was replaced");
    throw error;
  }
}

async function writeBody(response: DownloadResponse, path: string, append: boolean, start: number, expected: number | null, hooks: DownloadHooks, signal?: AbortSignal): Promise<number> {
  if (!response.body) throw unsafe("Download response has no body");
  await assertInbox(hooks);
  try { const stats = await lstat(path); if (stats.isSymbolicLink()) throw unsafe("Partial path is a symlink"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const flags = append ? constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW : constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;
  await assertInbox(hooks);
  const file = await open(path, flags, 0o600);
  let received = start;
  let cancel: (() => void) | undefined;
  try {
    const reader = response.body.getReader();
    let abortCancel: Promise<void> | undefined;
    cancel = () => { abortCancel ??= reader.cancel(); void abortCancel; };
    signal?.addEventListener("abort", cancel, { once: true });
    while (true) {
      if (signal?.aborted) throw cancelled();
      const next = await reader.read();
      if (signal?.aborted) {
        await (abortCancel ?? reader.cancel());
        throw cancelled();
      }
      if (next.done) break;
      await assertInbox(hooks);
      await file.write(next.value);
      received += next.value.byteLength;
      await hooks.onProgress?.(received, expected);
    }
    return received;
  } finally { if (cancel) signal?.removeEventListener("abort", cancel); await file.close(); }
}

async function responseFor(urlValue: string, headers: Record<string, string>, options: DownloadOptions, signal?: AbortSignal): Promise<DownloadResponse> {
  const transport = options.transport ?? createPinnedHttpsTransport();
  let current = urlValue;
  const maxRedirects = options.maxRedirects ?? 5;
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    // A raw DNS or socket rejection is a retryable outage; an abort that raced
    // the rejection stays a cancellation, and any typed error is preserved.
    let safe: ValidatedRemoteUrl;
    try {
      safe = await validateRemoteUrl(current, options.dnsLookup);
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      throw retryableTransportFailure(error) ?? error;
    }
    let response: DownloadResponse;
    try {
      response = await transport({ url: safe.url, address: safe.address, headers, signal });
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      throw retryableTransportFailure(error) ?? error;
    }
    if (!isRedirect(response.status)) return response;
    const location = response.headers.get("location");
    if (!location || redirects === maxRedirects) {
      await response.body?.cancel();
      throw unsafe("Too many or invalid download redirects");
    }
    await response.body?.cancel();
    current = new URL(location, safe.url).toString();
    if (response.status === 301 || response.status === 302 || response.status === 303) delete headers.Range;
  }
  throw unsafe("Too many download redirects");
}

export async function downloadJob(job: DownloadJobInput, provider: Pick<AcquisitionProvider, "requestDownloadUrl">, token: string, hooks: DownloadHooks, signal?: AbortSignal, options: DownloadOptions = {}): Promise<string> {
  const partPath = containedPath(hooks.inbox, `${job.id}.part`);
  if (basename(partPath) !== `${job.id}.part`) throw new ManagedPathError("Unsafe job identifier");
  let previous = 0;
  if (signal?.aborted) throw cancelled();
  await assertInbox(hooks);
  try { const stats = await lstat(partPath); if (stats.isSymbolicLink() || !stats.isFile()) throw unsafe("Partial path is unsafe"); previous = stats.size; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (let attempt = 0; attempt < 3; attempt++) {
    let capability: string;
    try {
      capability = await provider.requestDownloadUrl(token, job, signal);
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      throw error;
    }
    const ranged = previous > 0;
    const response = await responseFor(capability, ranged ? { Range: `bytes=${previous}-` } : {}, options, signal);
    if (signal?.aborted) {
      await response.body?.cancel();
      throw cancelled();
    }
    if ([401, 403, 404, 410].includes(response.status)) {
      await response.body?.cancel();
      // The locator is durable, so a fresh capability is the documented retry.
      if (attempt === 2) throw new DownloadError("CAPABILITY_EXPIRED", "Provider download capability expired", true);
      continue;
    }
    if (retryableStatus(response.status)) {
      await response.body?.cancel();
      const delay = retryDelay(response, attempt, options.now ?? Date.now);
      if (attempt === 2) throw new DownloadError("TEMPORARY_SERVICE_FAILURE", "Download service is temporarily unavailable", true, delay);
      await (hooks.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(delay);
      continue;
    }
    const range = response.status === 206 ? parsedContentRange(response) : null;
    const validRange = Boolean(range && range.start === previous &&
      (contentLength(response) === null || contentLength(response) === range.end - range.start + 1) &&
      (job.expectedBytes === null || range.total === job.expectedBytes));
    const append = ranged && response.status === 206 && validRange;
    if (ranged && response.status === 206 && !append) { await response.body?.cancel(); throw unsafe("Download range response is invalid"); }
    if (response.status !== 200 && !append) { await response.body?.cancel(); throw new DownloadError("PERMANENT_REJECTION", "Download request was rejected", false); }
    const total = append ? range!.total : job.expectedBytes ?? contentLength(response);
    const startingAt = append ? previous : 0;
    const bytesNeeded = Math.max(0, (total ?? 0) - startingAt);
    if (!(await (hooks.hasFreeBytes ?? ((bytes) => defaultSpace(hooks.inbox, bytes)))(bytesNeeded))) {
      await response.body?.cancel();
      throw new DownloadError("INSUFFICIENT_SPACE", "Insufficient disk space for download", false);
    }
    const received = await writeBody(response, partPath, append, startingAt, total, hooks, signal);
    if (total !== null && received !== total) throw unsafe("Downloaded byte count did not match response metadata");
    return partPath;
  }
  throw new DownloadError("TEMPORARY_SERVICE_FAILURE", "Download retries exhausted", true);
}
