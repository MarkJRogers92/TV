import type { ProviderName, RemoteFile, RemoteItem } from "../../acquisition/providerTypes.js";

export type ProviderErrorCode =
  | "AUTHENTICATION"
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  | "UNSUPPORTED_SCHEMA"
  | "PERMANENT";

/** A deliberately capability-safe error. Never attach response bodies or URLs. */
export class ProviderError extends Error {
  readonly name = "ProviderError";

  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export interface ProviderAccount {
  readonly label: string;
}

export interface AcquisitionProvider {
  readonly provider: ProviderName;
  testAuthentication(token: string, signal?: AbortSignal): Promise<ProviderAccount>;
  listCompletedItems(token: string, signal?: AbortSignal): Promise<readonly RemoteItem[]>;
  requestDownloadUrl(
    token: string,
    locator: Pick<
      RemoteFile,
      "provider" | "itemType" | "remoteItemId" | "remoteFileId"
    >,
    signal?: AbortSignal,
  ): Promise<string>;
}

/** Every adapter request is both caller-cancellable and independently bounded. */
export const providerRequestTimeoutMs = 15_000;

/**
 * A fetch implementation is not required to honour AbortSignal (test doubles
 * and some broken transports do not). Race it as well as aborting it, so a
 * stalled provider cannot retain a coordinator lifecycle indefinitely.
 */
export async function boundedProviderFetch(
  fetcher: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  signal?: AbortSignal,
  timeoutMs = providerRequestTimeoutMs,
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let callerAbort: (() => void) | undefined;
  const fail = (reject: (reason?: unknown) => void, caller: boolean) => {
    controller.abort();
    reject(caller ? new ProviderError("UNAVAILABLE", "Provider request cancelled", true) : unavailableError());
  };
  const aborted = new Promise<never>((_resolve, reject) => {
    callerAbort = () => fail(reject, true);
    if (signal?.aborted) {
      callerAbort();
      return;
    }
    signal?.addEventListener("abort", callerAbort, { once: true });
    timer = setTimeout(() => fail(reject, false), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      fetcher(input, { ...init, signal: controller.signal }),
      aborted,
    ]);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw unavailableError();
  } finally {
    if (timer) clearTimeout(timer);
    if (callerAbort) signal?.removeEventListener("abort", callerAbort);
  }
}

export function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export function responseError(response: Response): ProviderError {
  if (response.status === 401 || response.status === 403)
    return new ProviderError("AUTHENTICATION", "Provider authentication failed", false);
  if (response.status === 429)
    return new ProviderError(
      "RATE_LIMITED",
      "Provider rate limit reached",
      true,
      retryAfterMs(response.headers),
    );
  if (response.status >= 500)
    return new ProviderError("UNAVAILABLE", "Provider is temporarily unavailable", true);
  return new ProviderError("PERMANENT", "Provider request was rejected", false);
}

export function unavailableError(): ProviderError {
  return new ProviderError("UNAVAILABLE", "Provider is temporarily unavailable", true);
}

export function schemaError(): ProviderError {
  return new ProviderError("UNSUPPORTED_SCHEMA", "Provider response is unsupported", false);
}

export function permanentError(message = "Provider item is no longer available"): ProviderError {
  return new ProviderError("PERMANENT", message, false);
}

/** JSON parsing is an untrusted provider boundary, including stalled bodies. */
export async function readProviderJson(
  response: Response,
  signal?: AbortSignal,
  timeoutMs = providerRequestTimeoutMs,
): Promise<unknown> {
  const reader = response.body?.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let callerAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    const fail = () => {
      reject(unavailableError());
    };
    callerAbort = fail;
    if (signal?.aborted) {
      fail();
      return;
    }
    signal?.addEventListener("abort", callerAbort, { once: true });
    timer = setTimeout(fail, timeoutMs);
    timer.unref?.();
  });
  const parse = reader
    ? (async () => {
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        try {
          for (;;) {
            const result = await reader.read();
            if (result.done) break;
            totalBytes += result.value.byteLength;
            if (totalBytes > 4 * 1024 * 1024) {
              void reader.cancel().catch(() => undefined);
              throw schemaError();
            }
            chunks.push(result.value);
          }
          const body = new Uint8Array(totalBytes);
          let offset = 0;
          for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return JSON.parse(new TextDecoder().decode(body)) as unknown;
        } finally {
          reader.releaseLock();
        }
      })()
    : response.json();
  try {
    return await Promise.race([parse, interrupted]);
  } catch (error) {
    if (error instanceof ProviderError) {
      void reader?.cancel().catch(() => undefined);
      throw error;
    }
    throw schemaError();
  } finally {
    if (timer) clearTimeout(timer);
    if (callerAbort) signal?.removeEventListener("abort", callerAbort);
  }
}
