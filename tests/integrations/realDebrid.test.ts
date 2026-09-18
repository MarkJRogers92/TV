import { describe, expect, it, vi } from "vitest";
import {
  ProviderError,
  readProviderJson,
} from "../../src/integrations/acquisition/provider.js";
import { RealDebridProvider } from "../../src/integrations/acquisition/realDebrid.js";
import { parseVideoCandidate } from "../../src/acquisition/filename.js";

function json(value: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("RealDebridProvider", () => {
  it("continues through the official page boundary", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: String(index),
      filename: `torrent-${index}`,
      status: index === 0 ? "downloaded" : "downloading",
    }));
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(firstPage))
      .mockResolvedValueOnce(json({ id: "0", filename: "torrent-0", status: "downloaded", files: [], links: [] }))
      .mockResolvedValueOnce(json([]));
    const provider = new RealDebridProvider("https://rd.test", fetcher);
    await expect(provider.listCompletedItems("secret")).resolves.toHaveLength(1);
    expect(fetcher.mock.calls.map((call) => call[0])).toContain("https://rd.test/torrents?page=2&limit=100");
  });

  it("stops paginating instead of looping forever on endless full pages", async () => {
    // A provider stuck returning full pages used to spin here indefinitely, which
    // never resolves the poll cycle that owns the call - and because concurrent
    // callers coalesce onto that one cycle, polling would stop for good.
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      id: String(index),
      filename: `torrent-${index}`,
      status: "downloading",
    }));
    // A fresh Response per call: a body can only be read once, so reusing one
    // object would fail on the second page for the wrong reason.
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => json(fullPage));
    const provider = new RealDebridProvider("https://rd.test", fetcher);

    await expect(provider.listCompletedItems("secret")).rejects.toMatchObject({
      code: "UNAVAILABLE",
      retryable: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(50);
  });

  it("uses official auth, follows pagination, and aligns selected files to links", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ username: "mark" }))
      .mockResolvedValueOnce(json([{ id: "a", filename: "Show", status: "downloaded" }]))
      .mockResolvedValueOnce(json({ id: "a", filename: "Show", status: "downloaded", ended: "2026-09-14T00:00:00Z", files: [{ id: 4, path: "/Show/S01E01.mkv", bytes: 10, selected: 1 }, { id: 5, path: "/sample.mkv", bytes: 2, selected: 0 }], links: ["https://host.test/link"] }))
      .mockResolvedValueOnce(json({ id: "a", filename: "Show", status: "downloaded", files: [{ id: 4, path: "/Show/S01E01.mkv", bytes: 10, selected: 1 }], links: ["https://host.test/link"] }))
      .mockResolvedValueOnce(json({ download: "https://cdn.test/file" }));
    const provider = new RealDebridProvider("https://rd.test/rest", fetcher);
    await expect(provider.testAuthentication("secret")).resolves.toEqual({ label: "mark" });
    await expect(provider.listCompletedItems("secret")).resolves.toEqual([expect.objectContaining({ remoteItemId: "a", files: [expect.objectContaining({ remoteFileId: "4", originalFilename: "S01E01.mkv", remotePath: "Show/S01E01.mkv" })] })]);
    await expect(provider.requestDownloadUrl("secret", { provider: "real-debrid", itemType: "torrent", remoteItemId: "a", remoteFileId: "4" })).resolves.toBe("https://cdn.test/file");
    expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual(expect.any(Headers));
    expect((fetcher.mock.calls[0]?.[1]?.headers as Headers).get("authorization")).toBe("Bearer secret");
    const unrestrict = fetcher.mock.calls[4];
    expect(unrestrict?.[0]).toBe("https://rd.test/rest/unrestrict/link");
    expect(unrestrict?.[1]?.method).toBe("POST");
    expect((unrestrict?.[1]?.body as URLSearchParams).get("link")).toBe("https://host.test/link");
  });

  it("omits under- and over-aligned completed items before exposing a file", async () => {
    for (const links of [[], ["https://host.test/one", "https://host.test/two"]]) {
      const provider = new RealDebridProvider(
        "https://rd.test",
        vi.fn<typeof fetch>()
          .mockResolvedValueOnce(json([{ id: "a", filename: "Show", status: "downloaded" }]))
          .mockResolvedValueOnce(json({ id: "a", filename: "Show", status: "downloaded", files: [{ id: 4, path: "/Show/S01E01.mkv", selected: 1 }], links })),
      );
      await expect(provider.listCompletedItems("secret")).resolves.toEqual([]);
    }
  });

  it("skips an unusable legacy completion and continues to a safely aligned item", async () => {
    const provider = new RealDebridProvider(
      "https://rd.test",
      vi.fn<typeof fetch>()
        .mockResolvedValueOnce(json([
          { id: "legacy", filename: "Old Show", status: "downloaded" },
          { id: "wanted", filename: "Wanted Show", status: "downloaded" },
        ]))
        .mockResolvedValueOnce(json({
          id: "legacy",
          filename: "Old Show",
          status: "downloaded",
          files: [{ id: 1, path: "/Old/S01E01.mkv", selected: 1 }],
          links: [],
        }))
        .mockResolvedValueOnce(json({
          id: "wanted",
          filename: "Wanted Show",
          status: "downloaded",
          files: [{ id: 2, path: "/Wanted/S01E01.mkv", selected: 1 }],
          links: ["https://host.test/wanted"],
        })),
    );

    await expect(provider.listCompletedItems("secret")).resolves.toEqual([
      expect.objectContaining({
        remoteItemId: "wanted",
        files: [expect.objectContaining({ remoteFileId: "2" })],
      }),
    ]);
  });

  it.each(["//Show/S01E01.mkv", "/../Show/S01E01.mkv"])(
    "does not normalize malformed provider path %s into a safe video candidate",
    async (path) => {
      const provider = new RealDebridProvider(
        "https://rd.test",
        vi.fn<typeof fetch>()
          .mockResolvedValueOnce(json([{ id: "a", filename: "Show", status: "downloaded" }]))
          .mockResolvedValueOnce(json({
            id: "a",
            filename: "Show",
            status: "downloaded",
            files: [{ id: 4, path, selected: 1 }],
            links: ["https://host.test/link"],
          })),
      );
      const [item] = await provider.listCompletedItems("secret");
      expect(parseVideoCandidate(item.files[0])).toBeNull();
    },
  );

  it("returns bounded safe errors for auth, rate limiting, outages, and schema drift", async () => {
    const auth = new RealDebridProvider("https://rd.test", vi.fn<typeof fetch>().mockResolvedValue(json({}, 401)));
    await expect(auth.testAuthentication("leak-me")).rejects.toMatchObject({ code: "AUTHENTICATION", retryable: false });
    const rate = new RealDebridProvider("https://rd.test", vi.fn<typeof fetch>().mockResolvedValue(json({}, 429, { "retry-after": "3" })));
    await expect(rate.testAuthentication("leak-me")).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 3000 });
    const outage = new RealDebridProvider("https://rd.test", vi.fn<typeof fetch>().mockResolvedValue(json({}, 503)));
    await expect(outage.testAuthentication("leak-me")).rejects.toMatchObject({ code: "UNAVAILABLE", retryable: true });
    const drift = new RealDebridProvider("https://rd.test", vi.fn<typeof fetch>().mockImplementation(async () => json({ username: 2 })));
    await expect(drift.testAuthentication("leak-me")).rejects.toBeInstanceOf(ProviderError);
    await expect(drift.testAuthentication("leak-me")).rejects.toMatchObject({ code: "UNSUPPORTED_SCHEMA" });
  });

  it("never includes credentials or capability URLs in provider errors", async () => {
    const provider = new RealDebridProvider("https://rd.test", vi.fn<typeof fetch>().mockRejectedValue(new Error("https://cdn.test/file?token=secret")));
    await provider.testAuthentication("secret").catch((error: unknown) => {
      expect(JSON.stringify(error)).not.toContain("secret");
      expect(JSON.stringify(error)).not.toContain("cdn.test");
    });
  });

  it.each(["testAuthentication", "listCompletedItems", "requestDownloadUrl"] as const)("cancels a non-cooperating fetch for %s", async (method) => {
    let fetchSignal: AbortSignal | undefined;
    const provider = new RealDebridProvider("https://rd.test", vi.fn<typeof fetch>(async (_input, init) => {
      fetchSignal = init?.signal ?? undefined;
      return await new Promise<Response>(() => undefined);
    }));
    const abort = new AbortController();
    const call = method === "testAuthentication"
      ? provider.testAuthentication("secret", abort.signal)
      : method === "listCompletedItems"
        ? provider.listCompletedItems("secret", abort.signal)
        : provider.requestDownloadUrl("secret", { provider: "real-debrid", itemType: "torrent", remoteItemId: "a", remoteFileId: "4" }, abort.signal);
    await vi.waitFor(() => expect(fetchSignal).toBeDefined());
    abort.abort();
    await expect(call).rejects.toMatchObject({ code: "UNAVAILABLE", retryable: true });
  });

  it.each(["testAuthentication", "listCompletedItems", "requestDownloadUrl"] as const)(
    "cancels a %s response whose headers arrive but JSON body stalls",
    async (method) => {
    let bodyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    let bodyCancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull: async () => {
          bodyStarted();
          await new Promise<void>(() => undefined);
        },
        cancel: () => {
          bodyCancelled = true;
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
    const provider = new RealDebridProvider(
      "https://rd.test",
      vi.fn<typeof fetch>().mockResolvedValue(response),
    );
    const abort = new AbortController();
    const call = method === "testAuthentication"
      ? provider.testAuthentication("secret", abort.signal)
      : method === "listCompletedItems"
        ? provider.listCompletedItems("secret", abort.signal)
        : provider.requestDownloadUrl(
            "secret",
            {
              provider: "real-debrid",
              itemType: "torrent",
              remoteItemId: "a",
              remoteFileId: "4",
            },
            abort.signal,
          );
    await started;
    abort.abort();
    await expect(call).rejects.toMatchObject({
      code: "UNAVAILABLE",
      retryable: true,
    });
    await vi.waitFor(() => expect(bodyCancelled).toBe(true));
    },
  );

  it("cancels an oversized provider body even when the stream stays open", async () => {
    let bodyCancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
        },
        pull: async () => {
          await new Promise<void>(() => undefined);
        },
        cancel: () => {
          bodyCancelled = true;
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
    await expect(readProviderJson(response)).rejects.toMatchObject({
      code: "UNSUPPORTED_SCHEMA",
      retryable: false,
    });
    await vi.waitFor(() => expect(bodyCancelled).toBe(true));
  });

  it("turns malformed JSON and permanent locators into typed safe provider errors", async () => {
    const malformed = new RealDebridProvider("https://rd.test", vi.fn<typeof fetch>().mockResolvedValue(new Response("{", { status: 200 })));
    await expect(malformed.testAuthentication("secret")).rejects.toMatchObject({ code: "UNSUPPORTED_SCHEMA" });
    const missing = new RealDebridProvider(
      "https://rd.test",
      vi.fn<typeof fetch>().mockResolvedValue(
        json({ id: "gone", filename: "Show", status: "downloaded", files: [{ id: 4, path: "/Show/S01E01.mkv", selected: 1 }], links: ["https://host.test/link"] }),
      ),
    );
    await expect(missing.requestDownloadUrl("secret", { provider: "real-debrid", itemType: "torrent", remoteItemId: "gone", remoteFileId: "nope" })).rejects.toMatchObject({ code: "PERMANENT", retryable: false });
    await expect(missing.requestDownloadUrl("secret", { provider: "torbox", itemType: "torrent", remoteItemId: "gone", remoteFileId: "nope" })).rejects.toMatchObject({ code: "PERMANENT", retryable: false });
  });
});
