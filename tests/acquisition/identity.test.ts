import { describe, expect, test } from "vitest";
import {
  episodeKey,
  normalizedSeriesTitle,
  stremioSearchUrl,
} from "../../src/acquisition/identity.js";
import { episodeKey as modelEpisodeKey } from "../../src/acquisition/models.js";

describe("normalizedSeriesTitle", () => {
  test("folds case, punctuation, separators, whitespace and Unicode width", () => {
    expect(normalizedSeriesTitle("  Severance!! ")).toBe("severance");
    expect(normalizedSeriesTitle("Star Trek: Strange New Worlds")).toBe(
      "star trek strange new worlds",
    );
    expect(normalizedSeriesTitle("Law & Order")).toBe("law order");
    expect(normalizedSeriesTitle("The  Bear")).toBe("the bear");
    expect(normalizedSeriesTitle("Ｓｅｖｅｒａｎｃｅ")).toBe("severance");
    expect(normalizedSeriesTitle("Pokémon")).toBe("pokémon");
  });

  test("keeps meaningful title words, including numbers", () => {
    expect(normalizedSeriesTitle("Only Murders in the Building")).toBe(
      "only murders in the building",
    );
    expect(normalizedSeriesTitle("3 Body Problem")).toBe("3 body problem");
  });
});

describe("episodeKey", () => {
  test("builds the canonical normalized identity used by the database", () => {
    expect(episodeKey("Severance", 1, 2)).toBe("severance|s1|e2");
    expect(episodeKey("Ｓｅｖｅｒａｎｃｅ", 2, 10)).toBe("severance|s2|e10");
    expect(episodeKey("Star Trek: Strange New Worlds", 0, 1)).toBe(
      "star trek strange new worlds|s0|e1",
    );
  });

  test("re-exports the model helper instead of defining a second normalizer", () => {
    expect(episodeKey).toBe(modelEpisodeKey);
    expect(episodeKey("Pokémon: The Series", 3, 4)).toBe(
      modelEpisodeKey("Pokémon: The Series", 3, 4),
    );
  });
});

describe("stremioSearchUrl", () => {
  test("uses the exact stremio:///search?search= prefix with the encoded query", () => {
    const url = stremioSearchUrl({
      seriesTitle: "Severance",
      season: 1,
      episode: 2,
      episodeTitle: null,
    });
    expect(url).toBe("stremio:///search?search=Severance%20S01E02");
    expect(url.startsWith("stremio:///search?search=")).toBe(true);
    expect(
      decodeURIComponent(url.slice("stremio:///search?search=".length)),
    ).toBe("Severance S01E02");
  });

  test("appends the optional episode title", () => {
    expect(
      stremioSearchUrl({
        seriesTitle: "Severance",
        season: 1,
        episode: 2,
        episodeTitle: "Half Loop",
      }),
    ).toBe("stremio:///search?search=Severance%20S01E02%20Half%20Loop");
  });

  test("encodes Unicode and punctuation without pre-normalizing the title", () => {
    expect(
      stremioSearchUrl({
        seriesTitle: "Pokémon: The Series",
        season: 1,
        episode: 1,
        episodeTitle: "The Catch",
      }),
    ).toBe(
      "stremio:///search?search=Pok%C3%A9mon%3A%20The%20Series%20S01E01%20The%20Catch",
    );
    expect(
      stremioSearchUrl({
        seriesTitle: "Law & Order",
        season: 10,
        episode: 100,
        episodeTitle: null,
      }),
    ).toBe("stremio:///search?search=Law%20%26%20Order%20S10E100");
    expect(
      stremioSearchUrl({
        seriesTitle: "3 Body Problem",
        season: 0,
        episode: 7,
        episodeTitle: null,
      }),
    ).toBe("stremio:///search?search=3%20Body%20Problem%20S00E07");
  });

  test("zero-pads short season and episode numbers and trims blank parts", () => {
    expect(
      stremioSearchUrl({
        seriesTitle: "  Severance  ",
        season: 1,
        episode: 2,
        episodeTitle: "   ",
      }),
    ).toBe("stremio:///search?search=Severance%20S01E02");
    expect(
      stremioSearchUrl({
        seriesTitle: "Severance",
        season: 1,
        episode: 2,
      }),
    ).toBe("stremio:///search?search=Severance%20S01E02");
  });
});
