import { describe, expect, it, vi } from "vitest";
import { TorBoxProvider } from "../../src/integrations/acquisition/torBox.js";

function json(value: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("TorBoxProvider", () => {
  it("cancels a non-cooperating fetch without retaining the token", async () => {
    let fetchSignal: AbortSignal | undefined;
    const provider = new TorBoxProvider("https://torbox.test", vi.fn<typeof fetch>(async (_input, init) => {
      fetchSignal = init?.signal ?? undefined;
      return await new Promise<Response>(() => undefined);
    }));
    const abort = new AbortController();
    const call = provider.listCompletedItems("secret", abort.signal);
    await vi.waitFor(() => expect(fetchSignal).toBeDefined());
    abort.abort();
    await expect(call).rejects.toMatchObject({ code: "UNAVAILABLE", retryable: true });
  });
  it("uses bearer auth for account/listing, GET token-query download URL, and only true completions", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ success: true, data: { email: "mark@example.test" } }))
      .mockResolvedValueOnce(json({ success: true, data: [
        { id: 9, name: "Show S01E01", download_finished: true, updated_at: "2026-09-14T00:00:00Z", files: [{ id: 4, name: "Show/S01E01.mkv", size: 10 }] },
        { id: 10, name: "still working", download_finished: false, created_at: "2026-09-13T00:00:00Z", files: [] },
      ] }))
      .mockResolvedValueOnce(json({ success: true, data: "https://signed.torbox.test/file?token=download-token" }));
    const provider = new TorBoxProvider("https://tb.test", fetcher);
    await expect(provider.testAuthentication("secret token")).resolves.toEqual({ label: "mark@example.test" });
    await expect(provider.listCompletedItems("secret token")).resolves.toEqual([expect.objectContaining({ remoteItemId: "9", completedAt: "2026-09-14T00:00:00Z", files: [expect.objectContaining({ remoteFileId: "4", remotePath: "Show/S01E01.mkv" })] })]);
    await expect(provider.requestDownloadUrl("secret token", { provider: "torbox", itemType: "torrent", remoteItemId: "9", remoteFileId: "4" })).resolves.toContain("signed.torbox.test");
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      "https://tb.test/v1/api/user/me",
      "https://tb.test/v1/api/torrents/mylist",
      "https://tb.test/v1/api/torrents/requestdl?token=secret+token&torrent_id=9&file_id=4",
    ]);
    expect(fetcher.mock.calls.every((call) => call[1]?.method === "GET")).toBe(true);
    expect((fetcher.mock.calls[0]?.[1]?.headers as Headers).get("authorization")).toBe("Bearer secret token");
    expect((fetcher.mock.calls[1]?.[1]?.headers as Headers).get("authorization")).toBe("Bearer secret token");
    expect((fetcher.mock.calls[2]?.[1]?.headers as Headers).get("authorization")).toBeNull();
  });

  it("accepts null files on unfinished items and excludes them from completed results", async () => {
    const provider = new TorBoxProvider(
      "https://tb.test",
      vi.fn<typeof fetch>().mockResolvedValueOnce(json({ success: true, data: [
        { id: 8, name: "still working", download_finished: false, files: null },
        { id: 9, name: "Wanted Show", download_finished: true, files: [
          { id: 4, name: "Wanted/S01E01.mkv", size: 10 },
        ] },
      ] })),
    );

    await expect(provider.listCompletedItems("secret")).resolves.toEqual([
      expect.objectContaining({
        remoteItemId: "9",
        files: [expect.objectContaining({ remoteFileId: "4" })],
      }),
    ]);
  });

  it("rejects a torrent record whose files field is missing", async () => {
    const provider = new TorBoxProvider(
      "https://tb.test",
      vi.fn<typeof fetch>().mockResolvedValueOnce(json({ success: true, data: [
        { id: 8, name: "still working", download_finished: false },
      ] })),
    );

    await expect(provider.listCompletedItems("secret")).rejects.toMatchObject({
      code: "UNSUPPORTED_SCHEMA",
    });
  });

  it("returns safe typed auth, rate, outage, and schema errors", async () => {
    const auth = new TorBoxProvider("https://tb.test", vi.fn<typeof fetch>().mockResolvedValue(json({}, 401)));
    await expect(auth.testAuthentication("leak-me")).rejects.toMatchObject({ code: "AUTHENTICATION" });
    const rate = new TorBoxProvider("https://tb.test", vi.fn<typeof fetch>().mockResolvedValue(json({}, 429, { "retry-after": "2" })));
    await expect(rate.testAuthentication("leak-me")).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 2000 });
    const outage = new TorBoxProvider("https://tb.test", vi.fn<typeof fetch>().mockResolvedValue(json({}, 500)));
    await expect(outage.testAuthentication("leak-me")).rejects.toMatchObject({ code: "UNAVAILABLE", retryable: true });
    const drift = new TorBoxProvider("https://tb.test", vi.fn<typeof fetch>().mockResolvedValue(json({ success: true, data: { email: 7 } })));
    await expect(drift.testAuthentication("leak-me")).rejects.toMatchObject({ code: "UNSUPPORTED_SCHEMA" });
  });

  it("does not reflect a token-bearing failing URL", async () => {
    const provider = new TorBoxProvider("https://tb.test", vi.fn<typeof fetch>().mockRejectedValue(new Error("https://tb.test/?token=secret")));
    await provider.testAuthentication("secret").catch((error: unknown) => {
      expect(JSON.stringify(error)).not.toContain("secret");
      expect(JSON.stringify(error)).not.toContain("tb.test/?token");
    });
  });

  it("rejects malformed JSON and a foreign locator with typed errors", async () => {
    const malformed = new TorBoxProvider("https://tb.test", vi.fn<typeof fetch>().mockResolvedValue(new Response("{", { status: 200 })));
    await expect(malformed.testAuthentication("secret")).rejects.toMatchObject({ code: "UNSUPPORTED_SCHEMA" });
    const provider = new TorBoxProvider("https://tb.test", vi.fn<typeof fetch>());
    await expect(provider.requestDownloadUrl("secret", { provider: "real-debrid", itemType: "torrent", remoteItemId: "gone", remoteFileId: "nope" })).rejects.toMatchObject({ code: "PERMANENT", retryable: false });
  });
});
