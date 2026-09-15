import { afterEach, expect, test, vi } from "vitest";
import { markTvApi } from "../../web/api";

afterEach(() => vi.unstubAllGlobals());

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
