import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  createPinnedHttpsTransport,
  DownloadError,
  downloadJob,
} from "../../src/acquisition/downloader.js";
import { validateRemoteUrl } from "../../src/acquisition/remoteUrl.js";
import { captureManagedDirectory } from "../../src/acquisition/paths.js";

const job = { id: "job-1", provider: "torbox" as const, itemType: "torrent" as const, remoteItemId: "item", remoteFileId: "file", receivedBytes: 0, expectedBytes: 4 };
const provider = { requestDownloadUrl: async () => "https://downloads.example/video.mkv" };
function response(status: number, data: string, headers: Record<string, string> = {}) {
  return { status, headers: new Headers(headers), body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(data)); c.close(); } }) };
}

/**
 * Every download failure must be a typed `DownloadError`, never a bare
 * message. Tests assert the stable category and retryability instead of
 * branching on human-readable text.
 */
async function rejectedDownload(promise: Promise<unknown>): Promise<DownloadError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DownloadError);
    return error as DownloadError;
  }
  throw new Error("Expected the download to fail");
}

describe("validateRemoteUrl", () => {
  test("rejects credentialed and private destinations", async () => {
    await expect(validateRemoteUrl("https://key@example.com/file", async () => ["8.8.8.8"])).rejects.toThrow(/credential/i);
    await expect(validateRemoteUrl("https://metadata.example/file", async () => ["169.254.169.254"])).rejects.toThrow(/public/i);
  });

  test("rejects mapped IPv4 loopback and 6to4 private addresses", async () => {
    await expect(validateRemoteUrl("https://example.com/file", async () => ["::ffff:127.0.0.1"])).rejects.toThrow(/public/i);
    await expect(validateRemoteUrl("https://example.com/file", async () => ["2002:0a00:0001::"])).rejects.toThrow(/public/i);
  });

  test.each(["192.0.0.1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "::1", "fc00::1", "fe80::1", "ff02::1", "64:ff9b::808:808"])(
    "rejects special-use address %s",
    async (address) => expect(validateRemoteUrl("https://example.com/file", async () => [address])).rejects.toThrow(/public/i),
  );

  test("rejects explicit metadata names and accepts public IP literals without DNS", async () => {
    await expect(validateRemoteUrl("https://metadata.google.internal/file", async () => ["8.8.8.8"])).rejects.toThrow(/metadata/i);
    await expect(validateRemoteUrl("https://8.8.8.8/file", async () => { throw new Error("DNS must not run"); })).resolves.toMatchObject({ address: "8.8.8.8" });
  });

  test("rejects every 6to4 destination", async () => {
    await expect(validateRemoteUrl("https://example.com/file", async () => ["2002:0808:0808::"])).rejects.toThrow(/public/i);
  });
});

describe("downloadJob", () => {
  test("passes cancellation into capability generation even when the provider ignores it", async () => {
    const inbox = await mkdtemp(join(tmpdir(), "marktv-download-"));
    const abort = new AbortController();
    let seen: AbortSignal | undefined;
    const hanging = { requestDownloadUrl: async (_token: string, _job: unknown, signal?: AbortSignal) => {
      seen = signal;
      return await new Promise<string>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    } };
    const pending = downloadJob(job, hanging, "secret", { inbox }, abort.signal, { dnsLookup: async () => ["8.8.8.8"] });
    await vi.waitFor(() => expect(seen).toBe(abort.signal));
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
  });

  test.each(["replacement", "symlink"])("rejects a managed inbox %s before opening a part", async (kind) => {
    const parent = await mkdtemp(join(tmpdir(), "marktv-download-"));
    const inbox = join(parent, "inbox");
    await mkdir(inbox);
    // Production inboxes carry an identity token, so a same-path replacement is
    // caught even when ext4 hands the freed inode number straight back.
    const inboxIdentity = await captureManagedDirectory(inbox, { sentinel: true });
    const target = join(parent, "outside");
    await mkdir(target);
    const error = await rejectedDownload(downloadJob(job, provider, "secret", { inbox, inboxIdentity }, undefined, {
      dnsLookup: async () => ["8.8.8.8"],
      transport: async () => {
        // The replacement carries no identity token, so detection no longer
        // depends on the allocator declining to reuse the freed inode.
        await rm(inbox, { recursive: true });
        if (kind === "symlink") await symlink(target, inbox);
        else await mkdir(inbox);
        return response(200, "test", { "content-length": "4" });
      },
    }));
    expect(error.code).toBe("UNSAFE_DOWNLOAD");
    await expect(readFile(join(target, "job-1.part"))).rejects.toThrow();
  });

  test("pins the validated address while keeping the original TLS hostname and Host", async () => {
    let seen: { hostname: string; servername: string; host: string; resolved: string } | undefined;
    const transport = createPinnedHttpsTransport(async (options) => {
      await new Promise<void>((resolve, reject) => options.lookup(options.hostname, {}, (error, address) => error ? reject(error) : (seen = { hostname: options.hostname, servername: options.servername, host: String(options.headers.Host), resolved: typeof address === "string" ? address : address[0]?.address ?? "" }, resolve())));
      return response(200, "test", { "content-length": "4" });
    });
    const inbox = await mkdtemp(join(tmpdir(), "marktv-download-"));
    await downloadJob(job, provider, "secret", { inbox }, undefined, { dnsLookup: async () => ["8.8.8.8"], transport });
    expect(seen).toEqual({ hostname: "downloads.example", servername: "downloads.example", host: "downloads.example", resolved: "8.8.8.8" });
  });

  test("returns the pinned address in Node's all-address lookup shape", async () => {
    let seen: unknown;
    const transport = createPinnedHttpsTransport(async (options) => {
      await new Promise<void>((resolve, reject) =>
        options.lookup(options.hostname, { all: true }, (error, addresses) => {
          if (error) reject(error);
          else {
            seen = addresses;
            resolve();
          }
        }),
      );
      return response(200, "test", { "content-length": "4" });
    });
    const inbox = await mkdtemp(join(tmpdir(), "marktv-download-"));
    await downloadJob(job, provider, "secret", { inbox }, undefined, {
      dnsLookup: async () => ["8.8.8.8"],
      transport,
    });
    expect(seen).toEqual([{ address: "8.8.8.8", family: 4 }]);
  });

  test("streams a new response to a no-capability part path", async () => {
    const inbox = await mkdtemp(join(tmpdir(), "marktv-download-"));
    const progress: number[] = [];
    const partPath = await downloadJob(job, provider, "secret", { inbox, onProgress: (n) => { progress.push(n); } }, undefined, {
      dnsLookup: async () => ["8.8.8.8"],
      transport: async () => response(200, "test", { "content-length": "4" }),
    });
    expect(await readFile(partPath, "utf8")).toBe("test");
    expect(progress.at(-1)).toBe(4);
  });

  test("appends only a valid matching 206 range", async () => {
    const inbox = await mkdtemp(join(tmpdir(), "marktv-download-"));
    await writeFile(join(inbox, "job-1.part"), "te");
    const partPath = await downloadJob({ ...job, receivedBytes: 2 }, provider, "secret", { inbox }, undefined, {
      dnsLookup: async () => ["8.8.8.8"],
      transport: async (request) => {
        expect(request.headers.Range).toBe("bytes=2-");
        return response(206, "st", { "content-range": "bytes 2-3/4", "content-length": "2" });
      },
    });
    expect(await readFile(partPath, "utf8")).toBe("test");
  });

  test("restarts rather than appending when a ranged request gets 200", async () => {
    const inbox = await mkdtemp(join(tmpdir(), "marktv-download-"));
    await writeFile(join(inbox, "job-1.part"), "old");
    const partPath = await downloadJob({ ...job, receivedBytes: 3 }, provider, "secret", { inbox }, undefined, {
      dnsLookup: async () => ["8.8.8.8"], transport: async () => response(200, "test", { "content-length": "4" }),
    });
    expect(await readFile(partPath, "utf8")).toBe("test");
  });

  test("types a transient socket rejection as a retryable temporary failure", async () => {
    const inbox = await mkdtemp(join(tmpdir(), "marktv-download-"));
    const error = await rejectedDownload(downloadJob(job, provider, "secret", { inbox }, undefined, {
      dnsLookup: async () => ["8.8.8.8"],
      transport: async () => { throw Object.assign(new Error("read ECONNRESET https://downloads.example/video.mkv"), { code: "ECONNRESET" }); },
    }));
    expect(error.code).toBe("TEMPORARY_SERVICE_FAILURE");
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain("downloads.example");
  });

  test("types a transient DNS rejection as a retryable temporary failure", async () => {
    const inbox = await mkdtemp(join(tmpdir(), "marktv-download-"));
    const error = await rejectedDownload(downloadJob(job, provider, "secret", { inbox }, undefined, {
      dnsLookup: async () => { throw Object.assign(new Error("getaddrinfo EAI_AGAIN downloads.example"), { code: "EAI_AGAIN" }); },
      transport: async () => response(200, "test", { "content-length": "4" }),
    }));
    expect(error.code).toBe("TEMPORARY_SERVICE_FAILURE");
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain("downloads.example");
  });

  test("keeps an abort-race rejection typed as cancellation, not a retryable outage", async () => {
    const inbox = await mkdtemp(join(tmpdir(), "marktv-download-"));
    const abort = new AbortController();
    const error = await rejectedDownload(downloadJob(job, provider, "secret", { inbox }, abort.signal, {
      dnsLookup: async () => ["8.8.8.8"],
      transport: async () => {
        abort.abort();
        throw Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" });
      },
    }));
    expect(error.code).toBe("CANCELLED");
    expect(error.retryable).toBe(false);
    await expect(readFile(join(inbox, "job-1.part"))).rejects.toThrow();
  });

  test("leaves an untyped transport failure untyped and unretried", async () => {
    const inbox = await mkdtemp(join(tmpdir(), "marktv-download-"));
    let calls = 0;
    await expect(downloadJob(job, provider, "secret", { inbox }, undefined, {
      dnsLookup: async () => ["8.8.8.8"],
      transport: async () => { calls += 1; throw new Error("transport misconfigured"); },
    })).rejects.toThrow("transport misconfigured");
    expect(calls).toBe(1);
  });

  test("still refuses a credential-bearing capability URL and never reaches the transport", async () => {
    const inbox = await mkdtemp(join(tmpdir(), "marktv-download-"));
    let calls = 0;
    const credentialed = { requestDownloadUrl: async () => "https://key:secret@downloads.example/video.mkv" };
    await expect(downloadJob(job, credentialed, "token", { inbox }, undefined, {
      dnsLookup: async () => ["8.8.8.8"],
      transport: async () => { calls += 1; return response(200, "test", { "content-length": "4" }); },
    })).rejects.toThrow(/credential/i);
    expect(calls).toBe(0);
  });

  test("drops Range after a 302 redirect before retrying the revalidated target", async () => {
    const inbox = await mkdtemp(join(tmpdir(), "marktv-download-"));
    await writeFile(join(inbox, "job-1.part"), "te");
    const headers: Array<Record<string, string>> = [];
    let call = 0;
    await downloadJob({ ...job, receivedBytes: 2 }, provider, "secret", { inbox }, undefined, {
      dnsLookup: async () => ["8.8.8.8"], transport: async (request) => {
        headers.push({ ...request.headers }); call++;
        return call === 1 ? response(302, "", { location: "https://redirect.example/file" }) : response(200, "test", { "content-length": "4" });
      },
    });
    expect(headers[0].Range).toBe("bytes=2-");
    expect(headers[1].Range).toBeUndefined();
  });

  test("honors a bounded HTTP-date retry delay", async () => {
    const inbox = await mkdtemp(join(tmpdir(), "marktv-download-"));
    const waits: number[] = [];
    let call = 0;
    await downloadJob(job, provider, "secret", { inbox, sleep: async (ms) => { waits.push(ms); } }, undefined, {
      dnsLookup: async () => ["8.8.8.8"], now: () => 1_000, transport: async () => ++call === 1 ? response(503, "", { "retry-after": new Date(9_000).toUTCString() }) : response(200, "test", { "content-length": "4" }),
    });
    expect(waits).toEqual([5_000]);
  });

  test("cancels a rejected redirect body and a disk-rejected body", async () => {
    const inbox = await mkdtemp(join(tmpdir(), "marktv-download-"));
    let redirectCancelled = false;
    const redirectBody = new ReadableStream<Uint8Array>({ cancel() { redirectCancelled = true; } });
    const redirectError = await rejectedDownload(downloadJob(job, provider, "secret", { inbox }, undefined, {
      dnsLookup: async () => ["8.8.8.8"], transport: async () => ({ status: 302, headers: new Headers(), body: redirectBody }),
    }));
    expect(redirectError.message).toMatch(/redirect/i);
    expect(redirectError.code).toBe("UNSAFE_DOWNLOAD");
    expect(redirectError.retryable).toBe(false);
    expect(redirectCancelled).toBe(true);
    let diskCancelled = false;
    const diskBody = new ReadableStream<Uint8Array>({ cancel() { diskCancelled = true; } });
    const diskError = await rejectedDownload(downloadJob(job, provider, "secret", { inbox, hasFreeBytes: async () => false }, undefined, {
      dnsLookup: async () => ["8.8.8.8"], transport: async () => ({ status: 200, headers: new Headers({ "content-length": "4" }), body: diskBody }),
    }));
    expect(diskError.message).toMatch(/disk space/i);
    expect(diskError.code).toBe("INSUFFICIENT_SPACE");
    expect(diskError.retryable).toBe(false);
    expect(diskCancelled).toBe(true);
  });

  test("cancels a stalled unknown-length body when aborted", async () => {
    const inbox = await mkdtemp(join(tmpdir(), "marktv-download-"));
    const abort = new AbortController();
    let cancelled = false;
    const stalled = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const error = await rejectedDownload(downloadJob({ ...job, expectedBytes: null }, provider, "secret", { inbox }, abort.signal, {
      dnsLookup: async () => ["8.8.8.8"], transport: async () => { queueMicrotask(() => abort.abort()); return { status: 200, headers: new Headers(), body: stalled }; },
    }));
    expect(error.message).toMatch(/cancelled/i);
    expect(error.code).toBe("CANCELLED");
    expect(error.retryable).toBe(false);
    expect(cancelled).toBe(true);
  });

  test("reports an already-aborted download as a typed cancellation", async () => {
    const inbox = await mkdtemp(join(tmpdir(), "marktv-download-"));
    const abort = new AbortController();
    abort.abort();
    const error = await rejectedDownload(downloadJob(job, provider, "secret", { inbox }, abort.signal, {
      dnsLookup: async () => ["8.8.8.8"], transport: async () => response(200, "test", { "content-length": "4" }),
    }));
    expect(error.message).toMatch(/cancelled/i);
    expect(error.code).toBe("CANCELLED");
    expect(error.retryable).toBe(false);
    // Cancellation is surfaced before any local write, so no partial appears.
    await expect(readFile(join(inbox, "job-1.part"))).rejects.toThrow();
  });

  test("rejects a short body and leaves the partial for recovery", async () => {
    const inbox = await mkdtemp(join(tmpdir(), "marktv-download-"));
    const error = await rejectedDownload(downloadJob(job, provider, "secret", { inbox }, undefined, {
      dnsLookup: async () => ["8.8.8.8"], transport: async () => response(200, "bad", { "content-length": "4" }),
    }));
    expect(error.message).toMatch(/byte count/i);
    expect(error.code).toBe("UNSAFE_DOWNLOAD");
    expect(error.retryable).toBe(false);
    expect(await readFile(join(inbox, "job-1.part"), "utf8")).toBe("bad");
  });

  test("regenerates the capability and types an expired capability as retryable", async () => {
    const inbox = await mkdtemp(join(tmpdir(), "marktv-download-"));
    let requested = 0;
    const refreshing = {
      requestDownloadUrl: async () => {
        requested += 1;
        return "https://downloads.example/video.mkv";
      },
    };
    const error = await rejectedDownload(downloadJob(job, refreshing, "secret", { inbox }, undefined, {
      dnsLookup: async () => ["8.8.8.8"], transport: async () => response(401, ""),
    }));
    expect(error.message).toMatch(/capability expired/i);
    expect(error.code).toBe("CAPABILITY_EXPIRED");
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBeUndefined();
    expect(requested).toBe(3);
  });

  test("types a temporary service failure with its bounded retry-after", async () => {
    const inbox = await mkdtemp(join(tmpdir(), "marktv-download-"));
    const waits: number[] = [];
    let calls = 0;
    const error = await rejectedDownload(downloadJob(job, provider, "secret", { inbox, sleep: async (ms) => { waits.push(ms); } }, undefined, {
      dnsLookup: async () => ["8.8.8.8"],
      now: () => 1_000,
      transport: async () => {
        calls += 1;
        return response(503, "", { "retry-after": new Date(9_000).toUTCString() });
      },
    }));
    expect(error.message).toMatch(/temporarily unavailable/i);
    expect(error.code).toBe("TEMPORARY_SERVICE_FAILURE");
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(5_000);
    expect(waits).toEqual([5_000, 5_000]);
    expect(calls).toBe(3);
  });

  test("types a definitive HTTP rejection as permanent", async () => {
    const inbox = await mkdtemp(join(tmpdir(), "marktv-download-"));
    const error = await rejectedDownload(downloadJob(job, provider, "secret", { inbox }, undefined, {
      dnsLookup: async () => ["8.8.8.8"], transport: async () => response(451, ""),
    }));
    expect(error.message).toMatch(/rejected/i);
    expect(error.code).toBe("PERMANENT_REJECTION");
    expect(error.retryable).toBe(false);
  });

  test("cancels an unsafe range response and types it as unsafe", async () => {
    const inbox = await mkdtemp(join(tmpdir(), "marktv-download-"));
    await writeFile(join(inbox, "job-1.part"), "te");
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const error = await rejectedDownload(downloadJob({ ...job, receivedBytes: 2 }, provider, "secret", { inbox }, undefined, {
      dnsLookup: async () => ["8.8.8.8"],
      transport: async () => ({
        status: 206,
        headers: new Headers({ "content-range": "bytes 1-3/4", "content-length": "3" }),
        body,
      }),
    }));
    expect(error.message).toMatch(/range/i);
    expect(error.code).toBe("UNSAFE_DOWNLOAD");
    expect(error.retryable).toBe(false);
    expect(cancelled).toBe(true);
    expect(await readFile(join(inbox, "job-1.part"), "utf8")).toBe("te");
  });

  test("types a body-less response as unsafe", async () => {
    const inbox = await mkdtemp(join(tmpdir(), "marktv-download-"));
    const error = await rejectedDownload(downloadJob(job, provider, "secret", { inbox }, undefined, {
      dnsLookup: async () => ["8.8.8.8"],
      transport: async () => ({ status: 200, headers: new Headers({ "content-length": "4" }), body: null }),
    }));
    expect(error.message).toMatch(/no body/i);
    expect(error.code).toBe("UNSAFE_DOWNLOAD");
    expect(error.retryable).toBe(false);
  });
});
