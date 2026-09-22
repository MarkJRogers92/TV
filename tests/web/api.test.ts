import { afterEach, expect, test, vi } from "vitest";
import { markTvApi } from "../../web/api";

afterEach(() => vi.unstubAllGlobals());

const mediaRoot = {
  id: "root-1",
  path: "/media/tv",
  lastScannedAt: null,
  diagnostics: [],
};

const jsonResponse = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

test("scanMediaRoot posts without a JSON content type when the request has no body", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      jsonResponse({ root: mediaRoot, result: { items: [], diagnostics: [] } }),
    );
  vi.stubGlobal("fetch", fetcher);

  await markTvApi.scanMediaRoot("root-1");

  const call = fetcher.mock.calls[0];
  expect(call?.[0]).toBe("/api/v1/media/roots/root-1/scan");
  expect(call?.[1]?.method).toBe("POST");
  expect(call?.[1]?.body ?? null).toBeNull();
  expect(new Headers(call?.[1]?.headers).has("content-type")).toBe(false);
});

test("removeMediaRoot deletes without a JSON content type when the request has no body", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetcher);

  await markTvApi.removeMediaRoot("root-1");

  const call = fetcher.mock.calls[0];
  expect(call?.[0]).toBe("/api/v1/media/roots/root-1");
  expect(call?.[1]?.method).toBe("DELETE");
  expect(call?.[1]?.body ?? null).toBeNull();
  expect(new Headers(call?.[1]?.headers).has("content-type")).toBe(false);
});

test("requests with a body still send a JSON content type", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(mediaRoot));
  vi.stubGlobal("fetch", fetcher);

  await markTvApi.addMediaRoot("/media/tv");

  const call = fetcher.mock.calls[0];
  expect(call?.[0]).toBe("/api/v1/media/roots");
  expect(call?.[1]?.method).toBe("POST");
  expect(call?.[1]?.body).toBe(JSON.stringify({ path: "/media/tv" }));
  expect(new Headers(call?.[1]?.headers).get("content-type")).toBe(
    "application/json",
  );
});

test("Import Season encodes the durable pack id as one URL path segment", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        status: "scheduled",
        wantedIds: [],
        jobIds: [],
        alreadyImported: 1,
        alreadyScheduled: 0,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  vi.stubGlobal("fetch", fetcher);

  await markTvApi.importSeason(
    "season-pack:real-debrid:torrent:Q4IB:home%20improvement%201991:s1",
  );

  expect(fetcher.mock.calls[0]?.[0]).toBe(
    "/api/v1/acquisitions/reviews/season-pack%3Areal-debrid%3Atorrent%3AQ4IB%3Ahome%2520improvement%25201991%3As1/import-season",
  );
});

test("latestSchedule names the broadcast date it wants, when it has one", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response("null", { status: 200 }));
  vi.stubGlobal("fetch", fetcher);

  await markTvApi.latestSchedule("marktv-laughs", "2026-09-18");
  await markTvApi.latestSchedule("marktv-laughs");

  // Naming the date is how a caller avoids being answered with tomorrow's
  // pre-generated schedule; omitting it asks the server for the channel's
  // current date.
  expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
    "/api/v1/schedules/latest?channelId=marktv-laughs&date=2026-09-18",
    "/api/v1/schedules/latest?channelId=marktv-laughs",
  ]);
});

test("movie programming reads its status and writes its single control", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () =>
      jsonResponse({
        channelId: "marktv-laughs",
        enabled: false,
        upcoming: [],
        degraded: [],
      }),
    );
  vi.stubGlobal("fetch", fetcher);

  await markTvApi.movieProgrammingStatus("marktv-laughs");
  await markTvApi.setMovieProgramming("marktv-laughs", {
    enabled: true,
    poolIds: ["movies"],
  });

  expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
    "/api/v1/channels/marktv-laughs/movie-programming",
    "/api/v1/channels/marktv-laughs/movie-programming",
  ]);
  expect(fetcher.mock.calls[1]?.[1]?.method).toBe("PUT");
  expect(fetcher.mock.calls[1]?.[1]?.body).toBe(
    JSON.stringify({ enabled: true, poolIds: ["movies"] }),
  );
});
