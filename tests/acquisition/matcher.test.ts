import { describe, expect, test } from "vitest";
import {
  matchCompletedFiles,
  minimumPlausibleBytes,
  type MatchPlan,
  type MatchSelection,
} from "../../src/acquisition/matcher.js";
import { parseVideoCandidate } from "../../src/acquisition/filename.js";
import type { CompletedImport, WantedEpisode } from "../../src/acquisition/models.js";
import type { RemoteFile, RemoteItem } from "../../src/acquisition/providerTypes.js";

const megabyte = 1024 * 1024;

function wanted(overrides: Partial<WantedEpisode> = {}): WantedEpisode {
  return {
    id: "wanted-s1e2",
    seriesTitle: "Severance",
    season: 1,
    episode: 2,
    episodeTitle: null,
    status: "wanted",
    statusDetail: null,
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
    ...overrides,
  };
}

function file(overrides: Partial<RemoteFile> = {}): RemoteFile {
  return {
    provider: "real-debrid",
    itemType: "torrent",
    remoteItemId: "item-1",
    remoteFileId: "file-1",
    originalFilename: "Severance.S01E02.1080p.WEB-DL.x264-GROUP.mkv",
    remotePath: "",
    bytes: 1_400_000_000,
    ...overrides,
  };
}

function item(
  files: RemoteFile[],
  overrides: Partial<Omit<RemoteItem, "files">> = {},
): RemoteItem {
  return {
    provider: "real-debrid",
    itemType: "torrent",
    remoteItemId: files[0]?.remoteItemId ?? "item-1",
    originalName: "Severance.S01E02.1080p.WEB-DL.x264-GROUP",
    completedAt: "2026-09-14T01:00:00.000Z",
    ...overrides,
    files,
  };
}

function selection(overrides: Partial<MatchSelection> = {}): MatchSelection {
  return {
    wantedId: "wanted-s1e2",
    episodeKey: "severance|s1|e2",
    seriesTitle: "Severance",
    season: 1,
    episode: 2,
    provider: "real-debrid",
    itemType: "torrent",
    remoteItemId: "item-1",
    remoteFileId: "file-1",
    originalFilename: "Severance.S01E02.1080p.WEB-DL.x264-GROUP.mkv",
    resolution: "1080p",
    bytes: 1_400_000_000,
    ...overrides,
  };
}

function completedImport(overrides: Partial<CompletedImport> = {}): CompletedImport {
  return {
    id: "import-1",
    wantedId: "wanted-s1e2",
    episodeKey: "severance|s1|e2",
    provider: "real-debrid",
    remoteItemId: "item-legacy",
    remoteFileId: "file-legacy",
    mediaId: "media-1",
    canonicalName: "Severance - S01E02 - Half Loop.mkv",
    destinationPath: "/library/Severance - S01E02 - Half Loop.mkv",
    importedAt: "2026-09-14T02:00:00.000Z",
    ...overrides,
  };
}

function reviewCandidate(overrides: Record<string, unknown> = {}) {
  return {
    provider: "real-debrid",
    itemType: "torrent",
    remoteItemId: "item-1",
    remoteFileId: "file-1",
    filename: "Severance.S01E02.1080p.WEB-DL.x264-GROUP.mkv",
    sizeBytes: 1_400_000_000,
    resolution: "1080p",
    season: 1,
    episode: 2,
    ...overrides,
  };
}

describe("provider-neutral records", () => {
  test("carry no token, header, or URL field", () => {
    const remoteFileRecord = file();
    const remoteItemRecord = item([remoteFileRecord]);
    const forbidden = /token|secret|authorization|bearer|header|url|uri|link|credential|password|apikey|api_key/i;

    expect(Object.keys(remoteFileRecord).sort()).toEqual([
      "bytes",
      "itemType",
      "originalFilename",
      "provider",
      "remoteFileId",
      "remoteItemId",
      "remotePath",
    ]);
    expect(Object.keys(remoteItemRecord).sort()).toEqual([
      "completedAt",
      "files",
      "itemType",
      "originalName",
      "provider",
      "remoteItemId",
    ]);

    for (const record of [remoteFileRecord, remoteItemRecord]) {
      for (const [key, value] of Object.entries(record)) {
        expect(key).not.toMatch(forbidden);
        if (typeof value === "string") {
          expect(value).not.toMatch(/^https?:\/\//i);
        }
      }
    }
  });
});

describe("matchCompletedFiles exact identity", () => {
  test("ignores an item without a valid completion timestamp", () => {
    for (const completedAt of [null, "", "not-a-date"]) {
      expect(matchCompletedFiles([wanted()], [item([file()], { completedAt })], [])).toEqual({ kind: "none" });
    }
  });
  test("automatically selects the single exact episode", () => {
    const plan = matchCompletedFiles(
      [wanted()],
      [item([file()])],
      [],
    );
    expect(plan).toEqual({
      kind: "automatic",
      selections: [selection()],
    });
  });

  test("matches a canonical MarkTV filename", () => {
    const plan = matchCompletedFiles(
      [wanted({ season: 3, episode: 4, id: "wanted-s3e4" })],
      [
        item([
          file({
            originalFilename: "Severance - S03E04 - Episode Title.mkv",
            remoteFileId: "file-4",
          }),
        ]),
      ],
      [],
    );
    expect(plan).toEqual({
      kind: "automatic",
      selections: [
        selection({
          wantedId: "wanted-s3e4",
          episodeKey: "severance|s3|e4",
          season: 3,
          episode: 4,
          remoteFileId: "file-4",
          originalFilename: "Severance - S03E04 - Episode Title.mkv",
          resolution: null,
        }),
      ],
    });
  });

  test("returns none when the only remote candidate mimics a canonical extras name", () => {
    const plan = matchCompletedFiles(
      [wanted()],
      [
        item([
          file({
            originalFilename: "Severance - S01E02 - Trailer.mkv",
            remoteFileId: "file-trailer",
          }),
        ]),
      ],
      [],
    );
    expect(plan).toEqual({ kind: "none" });
  });

  test("prefers a real remote episode over a canonical-shaped extras name", () => {
    const plan = matchCompletedFiles(
      [wanted()],
      [
        item([
          file({
            originalFilename: "Severance - S01E02 - Extras.mkv",
            remoteFileId: "file-extras",
            bytes: 900 * megabyte,
          }),
          file({
            originalFilename: "Severance - S01E02 - Half Loop.mkv",
            remoteFileId: "file-real",
          }),
        ]),
      ],
      [],
    );
    expect(plan).toEqual({
      kind: "automatic",
      selections: [
        selection({
          remoteFileId: "file-real",
          originalFilename: "Severance - S01E02 - Half Loop.mkv",
          resolution: null,
        }),
      ],
    });
  });

  test("reuses the normalized episode key for unusual series titles", () => {
    const plan = matchCompletedFiles(
      [
        wanted({
          id: "wanted-s0e1",
          seriesTitle: "Star Trek: Strange New Worlds",
          season: 0,
          episode: 1,
        }),
      ],
      [
        item(
          [
            file({
              originalFilename:
                "Star.Trek.Strange.New.Worlds.S00E01.1080p.WEB-DL.mkv",
            }),
          ],
          {
            originalName: "Star.Trek.Strange.New.Worlds.S00E01.1080p.WEB-DL",
          },
        ),
      ],
      [],
    );
    expect(plan).toMatchObject({
      kind: "automatic",
      selections: [
        {
          wantedId: "wanted-s0e1",
          episodeKey: "star trek strange new worlds|s0|e1",
          season: 0,
          episode: 1,
        },
      ],
    });
  });

  test("does not match another season", () => {
    expect(
      matchCompletedFiles(
        [wanted({ season: 1, episode: 2 })],
        [item([file({ originalFilename: "Severance.S02E02.1080p.mkv" })])],
        [],
      ),
    ).toEqual({ kind: "none" });
  });

  test("does not match another episode number", () => {
    expect(
      matchCompletedFiles(
        [wanted({ season: 1, episode: 2 })],
        [item([file({ originalFilename: "Severance.S01E20.1080p.mkv" })])],
        [],
      ),
    ).toEqual({ kind: "none" });
  });

  test("does not match a different series title", () => {
    expect(
      matchCompletedFiles(
        [wanted({ seriesTitle: "Severance" })],
        [
          item(
            [file({ originalFilename: "Daredevil.S01E02.1080p.WEB-DL.mkv" })],
            { originalName: "Daredevil.S01E02.1080p.WEB-DL" },
          ),
        ],
        [],
      ),
    ).toEqual({ kind: "none" });
  });

  test("falls back to the item name when the file has no series prefix", () => {
    const plan = matchCompletedFiles(
      [wanted()],
      [
        item([file({ originalFilename: "S01E02.1080p.WEB-DL.mkv" })], {
          originalName: "Severance.S01.1080p.WEB-DL.x264-GROUP",
        }),
      ],
      [],
    );
    expect(plan).toMatchObject({
      kind: "automatic",
      selections: [{ remoteFileId: "file-1", season: 1, episode: 2 }],
    });
  });

  test("does not treat a longer untitled item name as an exact fallback", () => {
    expect(matchCompletedFiles(
      [wanted()],
      [item([file({ originalFilename: "S01E02.1080p.mkv" })], { originalName: "Severance Town.S01.1080p" })],
      [],
    )).toEqual({ kind: "none" });
  });

  test("does not classify an unrelated untitled item name by an empty title", () => {
    expect(matchCompletedFiles(
      [wanted()],
      [item([file({ originalFilename: "S01E02.1080p.mkv" })], { originalName: "Daredevil.S01.1080p" })],
      [],
    )).toEqual({ kind: "none" });
  });

  test("sends an uncertain title to review instead of guessing", () => {
    const plan = matchCompletedFiles(
      [wanted({ seriesTitle: "Severance" })],
      [
        item(
          [file({ originalFilename: "Severance.Town.S01E02.1080p.mkv" })],
          { originalName: "Severance.Town.S01.1080p" },
        ),
      ],
      [],
    );
    expect(plan).toEqual({
      kind: "review",
      reason: "uncertain-title",
      wantedId: "wanted-s1e2",
      episodeKey: "severance|s1|e2",
      candidates: [
        reviewCandidate({ filename: "Severance.Town.S01E02.1080p.mkv" }),
      ],
    });
  });

  test("returns none when nothing resolves and nothing is uncertain", () => {
    expect(matchCompletedFiles([], [item([file()])], [])).toEqual({
      kind: "none",
    });
    expect(matchCompletedFiles([wanted()], [], [])).toEqual({ kind: "none" });
  });

  test("keeps an automatic plan limited to resolved Wanted episodes", () => {
    const plan = matchCompletedFiles(
      [
        wanted({ id: "wanted-s1e3", episode: 3 }),
        wanted({ id: "wanted-s1e2", episode: 2 }),
      ],
      [item([file({ originalFilename: "Severance.S01E02.1080p.mkv" })])],
      [],
    );
    expect(plan).toEqual({
      kind: "automatic",
      selections: [
        selection({ originalFilename: "Severance.S01E02.1080p.mkv" }),
      ],
    });
  });
});

describe("matchCompletedFiles quality and ambiguity", () => {
  test("chooses the highest known resolution at or below 720p", () => {
    const plan = matchCompletedFiles(
      [wanted()],
      [
        item([
          file({ remoteFileId: "file-2160", originalFilename: "Severance.S01E02.2160p.mkv" }),
          file({ remoteFileId: "file-1080", originalFilename: "Severance.S01E02.1080p.mkv" }),
          file({ remoteFileId: "file-720", originalFilename: "Severance.S01E02.720p.mkv" }),
          file({ remoteFileId: "file-480", originalFilename: "Severance.S01E02.480p.mkv" }),
        ]),
      ],
      [],
    );
    expect(plan).toMatchObject({
      kind: "automatic",
      selections: [{ remoteFileId: "file-720", resolution: "720p" }],
    });
  });

  test("falls back to the lowest known resolution above 720p", () => {
    const plan = matchCompletedFiles(
      [wanted()],
      [
        item([
          file({ remoteFileId: "file-2160", originalFilename: "Severance.S01E02.2160p.mkv" }),
          file({ remoteFileId: "file-1080", originalFilename: "Severance.S01E02.1080p.mkv" }),
        ]),
      ],
      [],
    );
    expect(plan).toMatchObject({
      kind: "automatic",
      selections: [{ remoteFileId: "file-1080", resolution: "1080p" }],
    });
  });

  test("prefers a known resolution over an unknown one", () => {
    const plan = matchCompletedFiles(
      [wanted()],
      [
        item([
          file({ remoteFileId: "file-unknown", originalFilename: "Severance.S01E02.WEB-DL.mkv" }),
          file({ remoteFileId: "file-1080", originalFilename: "Severance.S01E02.1080p.mkv" }),
        ]),
      ],
      [],
    );
    expect(plan).toMatchObject({
      kind: "automatic",
      selections: [{ remoteFileId: "file-1080", resolution: "1080p" }],
    });
  });

  test("keeps an unknown-resolution candidate eligible", () => {
    const plan = matchCompletedFiles(
      [wanted()],
      [item([file({ originalFilename: "Severance.S01E02.WEB-DL.mkv" })])],
      [],
    );
    expect(plan).toEqual({
      kind: "automatic",
      selections: [
        selection({
          originalFilename: "Severance.S01E02.WEB-DL.mkv",
          resolution: null,
        }),
      ],
    });
  });

  test("treats equal best resolution as review regardless of size", () => {
    const plan = matchCompletedFiles(
      [wanted()],
      [
        item([
          file({
            remoteFileId: "file-small",
            originalFilename: "Severance.S01E02.1080p.WEB-DL-GRP1.mkv",
            bytes: 900_000_000,
          }),
          file({
            remoteFileId: "file-large",
            originalFilename: "Severance.S01E02.1080p.WEB-DL-GRP2.mkv",
            bytes: 9_000_000_000,
          }),
        ]),
      ],
      [],
    );
    expect(plan).toEqual({
      kind: "review",
      reason: "ambiguous",
      wantedId: "wanted-s1e2",
      episodeKey: "severance|s1|e2",
      candidates: [
        reviewCandidate({
          remoteFileId: "file-large",
          filename: "Severance.S01E02.1080p.WEB-DL-GRP2.mkv",
          sizeBytes: 9_000_000_000,
        }),
        reviewCandidate({
          remoteFileId: "file-small",
          filename: "Severance.S01E02.1080p.WEB-DL-GRP1.mkv",
          sizeBytes: 900_000_000,
        }),
      ],
    });
  });

  test("reviews when two candidates without resolutions are equally ranked", () => {
    const plan = matchCompletedFiles(
      [wanted()],
      [
        item([
          file({
            remoteFileId: "file-a",
            originalFilename: "Severance.S01E02.WEB-DL-GRP1.mkv",
            bytes: 900_000_000,
          }),
          file({
            remoteFileId: "file-b",
            originalFilename: "Severance.S01E02.WEB-DL-GRP2.mkv",
            bytes: 3_000_000_000,
          }),
        ]),
      ],
      [],
    );
    expect(plan).toMatchObject({
      kind: "review",
      reason: "ambiguous",
      candidates: [
        { remoteFileId: "file-b", resolution: null },
        { remoteFileId: "file-a", resolution: null },
      ],
    });
  });

  test("rejects known sizes below the plausibility floor", () => {
    const plan = matchCompletedFiles(
      [wanted()],
      [
        item([
          file({
            remoteFileId: "file-tiny",
            originalFilename: "Severance.S01E02.1080p.sample.mkv",
            bytes: 10 * megabyte,
          }),
          file({
            remoteFileId: "file-tiny-real",
            originalFilename: "Severance.S01E02.1080p.GRP1.mkv",
            bytes: 10 * megabyte,
          }),
          file({
            remoteFileId: "file-480",
            originalFilename: "Severance.S01E02.480p.GRP2.mkv",
            bytes: 900 * megabyte,
          }),
        ]),
      ],
      [],
    );
    expect(plan).toMatchObject({
      kind: "automatic",
      selections: [{ remoteFileId: "file-480", resolution: "480p" }],
    });
  });

  test("returns none when every known size is implausible", () => {
    expect(
      matchCompletedFiles(
        [wanted()],
        [
          item([
            file({
              originalFilename: "Severance.S01E02.1080p.mkv",
              bytes: minimumPlausibleBytes - 1,
            }),
          ]),
        ],
        [],
      ),
    ).toEqual({ kind: "none" });
  });

  test("keeps a file exactly at the plausibility floor", () => {
    const plan = matchCompletedFiles(
      [wanted()],
      [
        item([
          file({
            originalFilename: "Severance.S01E02.1080p.mkv",
            bytes: minimumPlausibleBytes,
          }),
        ]),
      ],
      [],
    );
    expect(plan).toMatchObject({
      kind: "automatic",
      selections: [{ bytes: minimumPlausibleBytes }],
    });
  });

  test("sends multi-episode files to review for every covered episode", () => {
    const plan = matchCompletedFiles(
      [wanted({ season: 1, episode: 3 })],
      [item([file({ originalFilename: "Severance.S01E02-E03.1080p.mkv" })])],
      [],
    );
    expect(plan).toEqual({
      kind: "review",
      reason: "multi-episode",
      wantedId: "wanted-s1e2",
      episodeKey: "severance|s1|e3",
      candidates: [
        reviewCandidate({
          filename: "Severance.S01E02-E03.1080p.mkv",
          season: 1,
          episode: 3,
        }),
      ],
    });
  });

  test("routes every episode inside a multi-episode range to review", () => {
    const plan = matchCompletedFiles(
      [wanted({ episode: 3 })],
      [item([file({ originalFilename: "Severance.S01E02-E04.1080p.mkv" })])],
      [],
    );
    expect(plan).toMatchObject({ kind: "review", reason: "multi-episode", candidates: [{ episode: 3 }] });
  });

  test("prefers the most severe review deterministically", () => {
    const plan = matchCompletedFiles(
      [
        wanted({ id: "wanted-s1e2", episode: 2 }),
        wanted({ id: "wanted-s1e5", episode: 5 }),
      ],
      [
        item([
          file({
            remoteFileId: "file-a",
            originalFilename: "Severance.S01E05.1080p.GRP1.mkv",
          }),
          file({
            remoteFileId: "file-b",
            originalFilename: "Severance.S01E05.1080p.GRP2.mkv",
          }),
        ]),
        item(
          [
            file({
              remoteItemId: "item-2",
              remoteFileId: "file-c",
              originalFilename: "Severance.S01E02E03.1080p.mkv",
            }),
          ],
          { remoteItemId: "item-2", originalName: "Severance.S01.1080p" },
        ),
      ],
      [],
    );
    expect(plan).toMatchObject({ kind: "review", reason: "multi-episode" });
    expect((plan as Extract<MatchPlan, { kind: "review" }>).candidates).toEqual([
      reviewCandidate({
        remoteItemId: "item-2",
        remoteFileId: "file-c",
        filename: "Severance.S01E02E03.1080p.mkv",
        season: 1,
        episode: 2,
      }),
    ]);
  });

  test("keeps colliding remote ids from two providers as distinct candidates", () => {
    const realDebridItem = item([
      file({ remoteItemId: "shared-item", remoteFileId: "shared-file" }),
    ], { remoteItemId: "shared-item", originalName: "Severance.S01.1080p" });
    const torBoxItem = item([
      file({ provider: "torbox", remoteItemId: "shared-item", remoteFileId: "shared-file" }),
    ], {
      provider: "torbox",
      remoteItemId: "shared-item",
      originalName: "Severance.S01.1080p",
    });
    const expected = {
      kind: "review",
      reason: "ambiguous",
      wantedId: "wanted-s1e2",
      episodeKey: "severance|s1|e2",
      candidates: [
        reviewCandidate({
          provider: "real-debrid",
          remoteItemId: "shared-item",
          remoteFileId: "shared-file",
        }),
        reviewCandidate({
          provider: "torbox",
          remoteItemId: "shared-item",
          remoteFileId: "shared-file",
        }),
      ],
    };
    expect(matchCompletedFiles([wanted()], [realDebridItem, torBoxItem], [])).toEqual(expected);
    // Provider identity, not input order, decides the deterministic ordering.
    expect(matchCompletedFiles([wanted()], [torBoxItem, realDebridItem], [])).toEqual(expected);
  });

  test("picks the provider-ordered review when equally severe reviews collide", () => {
    const plan = matchCompletedFiles(
      [
        wanted({ id: "wanted-s1e2", episode: 2 }),
        wanted({ id: "wanted-s1e5", episode: 5 }),
      ],
      [
        item(
          [
            file({
              remoteItemId: "z-item",
              remoteFileId: "f-a",
              originalFilename: "Severance.S01E05.1080p.GRP1.mkv",
            }),
            file({
              remoteItemId: "z-item",
              remoteFileId: "f-b",
              originalFilename: "Severance.S01E05.1080p.GRP2.mkv",
            }),
          ],
          { remoteItemId: "z-item", originalName: "Severance.S01.1080p" },
        ),
        item(
          [
            file({
              provider: "torbox",
              remoteItemId: "a-item",
              remoteFileId: "f-a",
              originalFilename: "Severance.S01E02.1080p.GRP1.mkv",
            }),
            file({
              provider: "torbox",
              remoteItemId: "a-item",
              remoteFileId: "f-b",
              originalFilename: "Severance.S01E02.1080p.GRP2.mkv",
            }),
          ],
          { provider: "torbox", remoteItemId: "a-item", originalName: "Severance.S01.1080p" },
        ),
      ],
      [],
    );
    expect(plan).toMatchObject({ kind: "review", reason: "ambiguous" });
    expect(
      (plan as Extract<MatchPlan, { kind: "review" }>).candidates.map(
        (candidate) => candidate.provider,
      ),
    ).toEqual(["real-debrid", "real-debrid"]);
  });
});

describe("matchCompletedFiles duplicates", () => {
  test("excludes a remote identity that was already imported", () => {
    expect(
      matchCompletedFiles(
        [wanted()],
        [item([file()])],
        [completedImport({ remoteItemId: "item-1", remoteFileId: "file-1" })],
      ),
    ).toEqual({ kind: "none" });
  });

  test("excludes an episode that was already imported from another file", () => {
    expect(
      matchCompletedFiles([wanted()], [item([file()])], [completedImport()]),
    ).toEqual({ kind: "none" });
  });

  test("keeps matching when the completed ledger only covers other episodes", () => {
    const plan = matchCompletedFiles(
      [wanted()],
      [item([file()])],
      [
        completedImport({
          id: "import-other",
          episodeKey: "severance|s1|e3",
          remoteItemId: "item-9",
          remoteFileId: "file-9",
        }),
      ],
    );
    expect(plan).toMatchObject({
      kind: "automatic",
      selections: [{ remoteFileId: "file-1" }],
    });
  });

  test("keeps another provider's colliding remote identity from excluding this one", () => {
    const plan = matchCompletedFiles(
      [wanted()],
      [item([file()])],
      [
        completedImport({
          id: "import-other",
          provider: "torbox",
          episodeKey: "severance|s1|e3",
          remoteItemId: "item-1",
          remoteFileId: "file-1",
        }),
      ],
    );
    expect(plan).toMatchObject({
      kind: "automatic",
      selections: [
        { provider: "real-debrid", remoteItemId: "item-1", remoteFileId: "file-1" },
      ],
    });
  });
});

describe("matchCompletedFiles season packs", () => {
  const packFiles = Array.from({ length: 10 }, (_, index) =>
    file({
      remoteFileId: `file-e${String(index + 1).padStart(2, "0")}`,
      originalFilename: `Severance.S03E${String(index + 1).padStart(2, "0")}.1080p.WEB-DL.mkv`,
      bytes: 1_000_000_000,
    }),
  );
  const packItem = item(packFiles, {
    originalName: "Severance.S03.1080p.WEB-DL.x264-GROUP",
  });

  test("offers each full-series collection for the requested season without selecting a competing bundle", () => {
    const seasonFiles = (remoteItemId: string, season: number) => Array.from(
      { length: 3 },
      (_, index) => file({
        remoteItemId,
        remoteFileId: `${remoteItemId}-s${season}e${index + 1}`,
        originalFilename: `Severance.S${String(season).padStart(2, "0")}E${String(index + 1).padStart(2, "0")}.720p.mkv`,
        bytes: 700_000_000,
      }),
    );
    const plan = matchCompletedFiles(
      [wanted({ id: "wanted-s1e1", season: 1, episode: 1 })],
      [
        item([...seasonFiles("collection-a", 1), ...seasonFiles("collection-a", 2)], { remoteItemId: "collection-a", originalName: "Severance.Complete.Series.A" }),
        item([...seasonFiles("collection-b", 1), ...seasonFiles("collection-b", 3)], { remoteItemId: "collection-b", originalName: "Severance.Complete.Series.B" }),
      ],
      [],
    );

    expect(plan).toMatchObject({ kind: "season-packs" });
    const offers = (plan as Extract<MatchPlan, { kind: "season-packs" }>).offers;
    expect(offers).toHaveLength(2);
    expect(offers.map((offer) => ({
      wantedId: offer.wantedId,
      remoteItemId: offer.packPreview.remoteItemId,
      season: offer.packPreview.season,
      recognizedEpisodeCount: offer.packPreview.recognizedEpisodeCount,
      seasons: [...new Set(offer.packPreview.fileLocators.map((file) => file.season))],
    }))).toEqual([
      { wantedId: "wanted-s1e1", remoteItemId: "collection-a", season: 1, recognizedEpisodeCount: 3, seasons: [1] },
      { wantedId: "wanted-s1e1", remoteItemId: "collection-b", season: 1, recognizedEpisodeCount: 3, seasons: [1] },
    ]);
  });

  test("does not suppress a same-season Wanted episode that is absent from a collection offer", () => {
    const collectionFiles = (season: number) => Array.from({ length: 3 }, (_, index) => file({
      remoteItemId: "collection", remoteFileId: `collection-s${season}e${index + 1}`,
      originalFilename: `Severance.S${String(season).padStart(2, "0")}E${String(index + 1).padStart(2, "0")}.720p.mkv`,
      bytes: 700_000_000,
    }));
    const plan = matchCompletedFiles(
      [wanted({ id: "wanted-s1e1", episode: 1 }), wanted({ id: "wanted-s1e4", episode: 4 })],
      [
        item([...collectionFiles(1), ...collectionFiles(2)], { remoteItemId: "collection", originalName: "Severance.Complete.Series" }),
        item([file({ remoteItemId: "single-e4", remoteFileId: "single-e4", originalFilename: "Severance.S01E04.720p.mkv", bytes: 700_000_000 })], { remoteItemId: "single-e4" }),
      ],
      [],
    );

    expect(plan).toMatchObject({ kind: "season-packs", coveredWantedIds: ["wanted-s1e1"] });
    expect((plan as Extract<MatchPlan, { kind: "season-packs" }>).selections).toMatchObject([
      { wantedId: "wanted-s1e4", remoteItemId: "single-e4", remoteFileId: "single-e4" },
    ]);
  });

  test("uses one deterministic file per requested-season episode in a collection offer", () => {
    const seasonFiles = (season: number) => Array.from({ length: 3 }, (_, index) => file({
      remoteItemId: "collection", remoteFileId: `collection-s${season}e${index + 1}`,
      originalFilename: `Severance.S${String(season).padStart(2, "0")}E${String(index + 1).padStart(2, "0")}.720p.mkv`,
      bytes: 700_000_000,
    }));
    const duplicate = file({
      remoteItemId: "collection", remoteFileId: "000-e1",
      originalFilename: "Severance.S01E01.720p.alt.mkv", bytes: 600_000_000,
    });
    const plan = matchCompletedFiles(
      [wanted({ id: "wanted-s1e1", episode: 1 })],
      [item([duplicate, ...seasonFiles(1), ...seasonFiles(2)], { remoteItemId: "collection", originalName: "Severance.Complete.Series" })],
      [],
    );

    const offer = (plan as Extract<MatchPlan, { kind: "season-packs" }>).offers[0]!;
    expect(offer.packPreview.fileLocators).toHaveLength(3);
    expect(offer.packPreview.fileLocators.map((locator) => locator.remoteFileId)).toEqual([
      "000-e1", "collection-s1e2", "collection-s1e3",
    ]);
    expect(offer.packPreview.totalBytes).toBe(2_000_000_000);
  });

  /** The whole recognized pack as persist-safe locators, in deterministic order. */
  function packLocatorFor(remoteFile: RemoteFile): Record<string, unknown> {
    const episode = Number(remoteFile.remoteFileId.slice("file-e".length));
    return reviewCandidate({
      provider: remoteFile.provider,
      itemType: remoteFile.itemType,
      remoteItemId: remoteFile.remoteItemId,
      remoteFileId: remoteFile.remoteFileId,
      filename: remoteFile.originalFilename,
      sizeBytes: remoteFile.bytes,
      season: 3,
      episode,
    });
  }

  function packLocators(remoteFiles: readonly RemoteFile[]): Array<Record<string, unknown>> {
    return [...remoteFiles]
      .sort(
        (a, b) =>
          a.provider.localeCompare(b.provider) ||
          a.itemType.localeCompare(b.itemType) ||
          a.remoteItemId.localeCompare(b.remoteItemId) ||
          a.remoteFileId.localeCompare(b.remoteFileId),
      )
      .map(packLocatorFor);
  }

  test("selects only Wanted episodes and previews the whole pack", () => {
    const plan = matchCompletedFiles(
      [
        wanted({ id: "wanted-s3e4", season: 3, episode: 4 }),
        wanted({ id: "wanted-s3e5", season: 3, episode: 5 }),
        wanted({ id: "wanted-s3e9", season: 3, episode: 9 }),
      ],
      [packItem],
      [],
    );
    expect(plan).toEqual({
      kind: "season-pack",
      wantedSelections: [
        selection({
          wantedId: "wanted-s3e4",
          episodeKey: "severance|s3|e4",
          season: 3,
          episode: 4,
          remoteFileId: "file-e04",
          originalFilename: "Severance.S03E04.1080p.WEB-DL.mkv",
          bytes: 1_000_000_000,
        }),
        selection({
          wantedId: "wanted-s3e5",
          episodeKey: "severance|s3|e5",
          season: 3,
          episode: 5,
          remoteFileId: "file-e05",
          originalFilename: "Severance.S03E05.1080p.WEB-DL.mkv",
          bytes: 1_000_000_000,
        }),
        selection({
          wantedId: "wanted-s3e9",
          episodeKey: "severance|s3|e9",
          season: 3,
          episode: 9,
          remoteFileId: "file-e09",
          originalFilename: "Severance.S03E09.1080p.WEB-DL.mkv",
          bytes: 1_000_000_000,
        }),
      ],
      packPreview: {
        provider: "real-debrid",
        itemType: "torrent",
        remoteItemId: "item-1",
        seriesTitle: "Severance",
        season: 3,
        recognizedEpisodeCount: 10,
        // Automatic work remains Wanted-only, while the manual-season preview
        // reports the required bytes for the whole recognized pack.
        totalBytes: 10_000_000_000,
        fileLocators: packLocators(packFiles),
      },
    });
  });

  test("retains a locator for every recognized pack file, not only Wanted ones", () => {
    const plan = matchCompletedFiles(
      [wanted({ id: "wanted-s3e5", season: 3, episode: 5 })],
      [packItem],
      [],
    );
    expect(plan).toMatchObject({ kind: "season-pack" });
    const preview = (plan as Extract<MatchPlan, { kind: "season-pack" }>).packPreview;
    expect(preview.fileLocators).toEqual(packLocators(packFiles));
    expect(preview.fileLocators).toHaveLength(10);
    expect(preview.recognizedEpisodeCount).toBe(preview.fileLocators.length);
    expect(preview.totalBytes).toBe(10_000_000_000);
    expect(
      preview.fileLocators.reduce((sum, locator) => sum + (locator.sizeBytes ?? 0), 0),
    ).toBe(10_000_000_000);
  });

  test("keeps every locator revalidatable against the re-listed pack", () => {
    const plan = matchCompletedFiles(
      [wanted({ id: "wanted-s3e5", season: 3, episode: 5 })],
      [packItem],
      [],
    );
    const preview = (plan as Extract<MatchPlan, { kind: "season-pack" }>).packPreview;
    for (const locator of preview.fileLocators) {
      const listed = packItem.files.find(
        (remoteFile) =>
          remoteFile.provider === locator.provider &&
          remoteFile.itemType === locator.itemType &&
          remoteFile.remoteItemId === locator.remoteItemId &&
          remoteFile.remoteFileId === locator.remoteFileId,
      );
      expect(listed).toBeDefined();
      const parsed = parseVideoCandidate(listed!);
      expect(parsed?.originalFilename).toBe(locator.filename);
      expect(parsed?.season).toBe(locator.season);
      expect(parsed?.episode).toBe(locator.episode);
      expect(parsed?.bytes).toBe(locator.sizeBytes);
      expect(parsed?.resolution).toBe(locator.resolution);
    }
  });

  test("reports a null total when a selected size is unknown", () => {
    const plan = matchCompletedFiles(
      [wanted({ id: "wanted-s3e5", season: 3, episode: 5 })],
      [
        item([
          ...packFiles.slice(0, 4),
          file({
            remoteFileId: "file-e05",
            originalFilename: "Severance.S03E05.1080p.WEB-DL.mkv",
            bytes: null,
          }),
          ...packFiles.slice(5),
        ]),
      ],
      [],
    );
    expect(plan).toMatchObject({
      kind: "season-pack",
      packPreview: { recognizedEpisodeCount: 10, totalBytes: null },
    });
    const preview = (plan as Extract<MatchPlan, { kind: "season-pack" }>).packPreview;
    expect(preview.fileLocators).toHaveLength(10);
    expect(preview.fileLocators.find((locator) => locator.remoteFileId === "file-e05")?.sizeBytes).toBeNull();
  });

  test("does not inflate pack recognition with tiny, other-series, or other-season files", () => {
    const plan = matchCompletedFiles(
      [wanted({ id: "wanted-s3e4", season: 3, episode: 4 })],
      [item([
        ...packFiles.slice(0, 2),
        packFiles[3],
        file({ remoteFileId: "tiny", originalFilename: "Severance.S03E50.1080p.mkv", bytes: minimumPlausibleBytes - 1 }),
        file({ remoteFileId: "other-show", originalFilename: "Daredevil.S03E01.1080p.mkv" }),
        file({ remoteFileId: "other-season", originalFilename: "Severance.S04E01.1080p.mkv" }),
      ])],
      [],
    );
    expect(plan).toMatchObject({ kind: "season-pack", packPreview: { recognizedEpisodeCount: 3 } });
  });

  test("counts recognized episodes but skips completed identities", () => {
    const plan = matchCompletedFiles(
      [
        wanted({ id: "wanted-s3e4", season: 3, episode: 4 }),
        wanted({ id: "wanted-s3e6", season: 3, episode: 6 }),
        wanted({ id: "wanted-s3e9", season: 3, episode: 9 }),
      ],
      [packItem],
      [completedImport({ remoteItemId: "item-1", remoteFileId: "file-e09" })],
    );
    expect(plan).toMatchObject({
      kind: "season-pack",
      wantedSelections: [
        { remoteFileId: "file-e04" },
        { remoteFileId: "file-e06" },
      ],
      packPreview: { recognizedEpisodeCount: 10, totalBytes: 10_000_000_000 },
    });
  });

  test("keeps a mixed pack and single-file plan automatic", () => {
    const plan = matchCompletedFiles(
      [
        wanted({ id: "wanted-s3e4", season: 3, episode: 4 }),
        wanted({ id: "wanted-s3e5", season: 3, episode: 5 }),
      ],
      [
        packItem,
        item(
          [
            file({
              remoteItemId: "item-2",
              remoteFileId: "file-720",
              originalFilename: "Severance.S03E04.720p.WEB-DL.mkv",
              bytes: 700_000_000,
            }),
          ],
          { remoteItemId: "item-2", originalName: "Severance.S03E04.720p.WEB-DL" },
        ),
      ],
      [],
    );
    expect(plan).toEqual({
      kind: "automatic",
      selections: [
        selection({
          wantedId: "wanted-s3e4",
          episodeKey: "severance|s3|e4",
          season: 3,
          episode: 4,
          remoteItemId: "item-2",
          remoteFileId: "file-720",
          originalFilename: "Severance.S03E04.720p.WEB-DL.mkv",
          resolution: "720p",
          bytes: 700_000_000,
        }),
        selection({
          wantedId: "wanted-s3e5",
          episodeKey: "severance|s3|e5",
          season: 3,
          episode: 5,
          remoteFileId: "file-e05",
          originalFilename: "Severance.S03E05.1080p.WEB-DL.mkv",
          bytes: 1_000_000_000,
        }),
      ],
    });
  });
});

describe("matchCompletedFiles determinism", () => {
  test("does not depend on the input order", () => {
    const remoteFiles = [
      file({
        remoteFileId: "file-a",
        originalFilename: "Severance.S01E02.1080p.GRP1.mkv",
      }),
      file({
        remoteFileId: "file-b",
        originalFilename: "Severance.S01E02.1080p.GRP2.mkv",
      }),
      file({
        remoteFileId: "file-c",
        originalFilename: "Severance.S01E03.720p.mkv",
      }),
    ];
    const wantedEpisodes = [
      wanted({ id: "wanted-s1e2", episode: 2 }),
      wanted({ id: "wanted-s1e3", episode: 3 }),
    ];
    const forward = matchCompletedFiles(
      wantedEpisodes,
      [item(remoteFiles)],
      [],
    );
    const reversed = matchCompletedFiles(
      [...wantedEpisodes].reverse(),
      [item([...remoteFiles].reverse())],
      [],
    );
    expect(reversed).toEqual(forward);
    expect(forward).toMatchObject({
      kind: "review",
      reason: "ambiguous",
      candidates: [
        { remoteFileId: "file-a" },
        { remoteFileId: "file-b" },
      ],
    });
  });
});
