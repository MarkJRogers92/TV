import { expect, test } from "vitest";
import fixturePack from "../fixtures/marktvAutopilotAcceptance.json";
import type { MediaItem, Pool } from "../../src/domain/models.js";
import { selectCandidate } from "../../src/scheduler/select.js";

function scenario(id: string) {
  const item = fixturePack.scenarios.find((entry) => entry.id === id);
  if (!item) throw new Error(`missing package scenario ${id}`);
  return item;
}

test("package F02: an absent successor holds only its series", () => {
  const fixture = scenario("F02");
  const given = fixture.given as {
    series_a_completed: number;
    series_a_next: number;
    series_a_available_episodes: number[];
    series_b_next: number;
  };
  const episode = (series: "a" | "b", number: number): MediaItem => ({
    id: `series_${series}_episode_${number}`,
    source: "placeholder",
    kind: "episode",
    title: `Episode ${number}`,
    showTitle: `Series ${series.toUpperCase()}`,
    season: 1,
    episode: number,
    durationMs: 30 * 60_000,
    durationStatus: "ok",
    available: true,
    tags: [],
  });
  const a = given.series_a_available_episodes.map((number) => episode("a", number));
  const b = [episode("b", given.series_b_next)];
  const items = [...a, episode("b", given.series_b_next - 1), ...b];
  const pool: Pool = {
    id: "package-f02",
    name: "Package F02",
    kinds: ["episode"],
    mediaIds: items.map(({ id }) => id),
    mode: "chronological",
    noRepeatMinutes: 0,
    weight: 1,
  };
  const history = [
    { mediaId: `series_a_episode_${given.series_a_completed}`, at: "2026-09-23T02:00:00.000Z" },
    { mediaId: `series_b_episode_${given.series_b_next - 1}`, at: "2026-09-23T01:00:00.000Z" },
  ];
  const selected = selectCandidate({
    pool,
    items,
    kind: "episode",
    history,
    at: "2026-09-23T03:00:00.000Z",
    seed: "package-f02",
  });
  expect(selected.item?.id).toBe(fixture.expected.select);
  for (const excluded of fixture.expected.must_not_select as string[]) {
    expect(selected.item?.id).not.toBe(excluded);
  }
  expect(given.series_a_available_episodes).not.toContain(given.series_a_next);
});
