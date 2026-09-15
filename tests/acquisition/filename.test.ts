import { describe, expect, test } from "vitest";
import {
  maximumEpisodeNumber,
  maximumSeasonNumber,
  parseVideoCandidate,
  videoExtensions,
} from "../../src/acquisition/filename.js";
import type {
  ParsedVideoCandidate,
  VideoResolution,
} from "../../src/acquisition/filename.js";
import type { RemoteFile } from "../../src/acquisition/providerTypes.js";

function remoteFile(overrides: Partial<RemoteFile> = {}): RemoteFile {
  return {
    provider: "torbox",
    itemType: "torrent",
    remoteItemId: "item-7",
    remoteFileId: "file-9",
    originalFilename: "Severance.S01E02.1080p.WEB-DL.mkv",
    remotePath: "",
    bytes: 1_600_000_000,
    ...overrides,
  };
}

describe("parseVideoCandidate", () => {
  test("keeps the provider-neutral locator and recognized facts", () => {
    expect(parseVideoCandidate(remoteFile())).toEqual({
      provider: "torbox",
      itemType: "torrent",
      remoteItemId: "item-7",
      remoteFileId: "file-9",
      originalFilename: "Severance.S01E02.1080p.WEB-DL.mkv",
      remotePath: "",
      bytes: 1_600_000_000,
      seriesTitle: "Severance",
      episodeTitle: null,
      season: 1,
      episode: 2,
      episodeEnd: null,
      multiEpisode: false,
      resolution: "1080p",
      resolutionHeight: 1080,
    });
  });

  const accepted: Array<{
    label: string;
    filename: string;
    remotePath?: string;
    expected: Partial<ParsedVideoCandidate>;
  }> = [
    {
      label: "canonical MarkTV name",
      filename: "Severance - S03E04 - Episode Title.mkv",
      expected: {
        seriesTitle: "Severance",
        episodeTitle: "Episode Title",
        season: 3,
        episode: 4,
        resolution: null,
      },
    },
    {
      label: "canonical MarkTV name with dotted title",
      filename: "Agents of S.H.I.E.L.D. - S02E03 - Making Friends.mp4",
      expected: {
        seriesTitle: "Agents of S.H.I.E.L.D.",
        episodeTitle: "Making Friends",
        season: 2,
        episode: 3,
      },
    },
    {
      label: "dotted scene name",
      filename: "Severance.S01E02.1080p.WEB-DL.x264-GROUP.mkv",
      expected: {
        seriesTitle: "Severance",
        episodeTitle: null,
        season: 1,
        episode: 2,
        resolution: "1080p",
        resolutionHeight: 1080,
      },
    },
    {
      label: "dotted scene name with episode title",
      filename: "The.Bear.S03E04.Something.1080p.WEB-DL.mkv",
      expected: {
        seriesTitle: "The Bear",
        episodeTitle: "Something",
        season: 3,
        episode: 4,
      },
    },
    {
      label: "single digit season and episode",
      filename: "severance s1e2 720p.mkv",
      expected: {
        seriesTitle: "severance",
        episodeTitle: null,
        season: 1,
        episode: 2,
        resolution: "720p",
        resolutionHeight: 720,
      },
    },
    {
      label: "NxM form",
      filename: "Severance.1x02.HDTV.mkv",
      expected: {
        seriesTitle: "Severance",
        season: 1,
        episode: 2,
        resolution: null,
      },
    },
    {
      label: "underscores and multi-digit episode",
      filename: "Some_Show_2x13_480p.avi",
      expected: {
        seriesTitle: "Some Show",
        season: 2,
        episode: 13,
        resolution: "480p",
        resolutionHeight: 480,
      },
    },
    {
      label: "episode marker with no series prefix",
      filename: "S01E02.1080p.mkv",
      remotePath: "Severance.S01.1080p.WEB-DL/S01E02.1080p.mkv",
      expected: {
        seriesTitle: null,
        episodeTitle: null,
        season: 1,
        episode: 2,
        resolution: "1080p",
      },
    },
    {
      label: "largest allowed season and episode",
      filename: "Show.S99E999.1080p.mkv",
      expected: { season: maximumSeasonNumber, episode: maximumEpisodeNumber },
    },
    {
      label: "token boundary keeps legitimately titled words",
      filename: "Severance.S01E02.Sampler.1080p.mkv",
      expected: { episodeTitle: "Sampler", season: 1, episode: 2 },
    },
    {
      label: "keeps a series whose name contains a rejection word",
      filename: "Trailer Park Boys.S01E02.1080p.mkv",
      expected: { seriesTitle: "Trailer Park Boys", season: 1, episode: 2 },
    },
  ];

  test.each(accepted)("parses $label", ({ filename, remotePath, expected }) => {
    const parsed = parseVideoCandidate(
      remoteFile({ originalFilename: filename, remotePath: remotePath ?? "" }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject(expected);
  });

  // A remote filename can mimic the canonical `Series - SxxEyy - Title` shape,
  // so untrusted parsing must still reject extras-style episode titles.
  const canonicalExtraTitles: Array<{
    label: string;
    filename: string;
    episodeTitle: string;
  }> = [
    {
      label: "Sample",
      filename: "Severance - S03E04 - Sample.mkv",
      episodeTitle: "Sample",
    },
    {
      label: "Trailer",
      filename: "Severance - S03E04 - Trailer.mkv",
      episodeTitle: "Trailer",
    },
    {
      label: "lowercase trailer",
      filename: "Severance - S03E04 - trailer.mkv",
      episodeTitle: "trailer",
    },
    {
      label: "Featurette",
      filename: "Severance - S03E04 - Featurette.mp4",
      episodeTitle: "Featurette",
    },
    {
      label: "Featurettes",
      filename: "Severance - S03E04 - Featurettes.mkv",
      episodeTitle: "Featurettes",
    },
    {
      label: "Extra",
      filename: "Severance - S03E04 - Extra.mkv",
      episodeTitle: "Extra",
    },
    {
      label: "Extras",
      filename: "Severance - S03E04 - Extras.mkv",
      episodeTitle: "Extras",
    },
    {
      label: "Sample embedded in a longer title",
      filename: "Severance - S03E04 - A Sample of Things to Come.mkv",
      episodeTitle: "A Sample of Things to Come",
    },
    {
      label: "Extras and Featurette in a longer title",
      filename: "Severance - S03E04 - Deleted Extras and Featurette.mkv",
      episodeTitle: "Deleted Extras and Featurette",
    },
    {
      label: "canonical multi-episode range with an extras-style title",
      filename: "Severance - S03E04-E05 - Trailers and Extras.mkv",
      episodeTitle: "Trailers and Extras",
    },
  ];

  test.each(canonicalExtraTitles)(
    "rejects the remote canonical-shaped episode title $label",
    ({ filename }) => {
      expect(parseVideoCandidate(remoteFile({ originalFilename: filename }))).toBeNull();
      expect(
        parseVideoCandidate(remoteFile({ originalFilename: filename }), {
          trustedManagedCanonical: false,
        }),
      ).toBeNull();
    },
  );

  test.each(canonicalExtraTitles)(
    "trusts the managed canonical episode title $label when opted in",
    ({ filename, episodeTitle }) => {
      const parsed = parseVideoCandidate(
        remoteFile({ originalFilename: filename }),
        { trustedManagedCanonical: true },
      );
      expect(parsed).not.toBeNull();
      expect(parsed).toMatchObject({
        seriesTitle: "Severance",
        episodeTitle,
        season: 3,
        episode: 4,
      });
    },
  );

  test("defaults to untrusted parsing and keeps every other canonical fact", () => {
    const canonicalName = remoteFile({
      originalFilename: "Severance - S03E04 - Episode Title.mkv",
    });
    expect(parseVideoCandidate(canonicalName)).toMatchObject({
      seriesTitle: "Severance",
      episodeTitle: "Episode Title",
      season: 3,
      episode: 4,
    });
    expect(parseVideoCandidate(canonicalName, {})).toMatchObject({
      episodeTitle: "Episode Title",
    });
    expect(
      parseVideoCandidate(
        remoteFile({ originalFilename: "Severance - S03E04 - Trailer.mkv" }),
      ),
    ).toBeNull();
    // The trust switch also accepts a bare boolean for single-flag callers.
    expect(
      parseVideoCandidate(
        remoteFile({ originalFilename: "Severance - S03E04 - Trailer.mkv" }),
        true,
      ),
    ).toMatchObject({ episodeTitle: "Trailer" });
    expect(
      parseVideoCandidate(
        remoteFile({ originalFilename: "Severance - S03E04 - Trailer.mkv" }),
        false,
      ),
    ).toBeNull();
  });

  const resolutions: Array<{ filename: string; resolution: VideoResolution | null }> = [
    { filename: "Show.S01E02.mkv", resolution: null },
    { filename: "Show.S01E02.2160p.mkv", resolution: "2160p" },
    { filename: "Show.S01E02.4K.mkv", resolution: "2160p" },
    { filename: "Show.S01E02.UHD.HEVC.mkv", resolution: "2160p" },
    { filename: "Show.S01E02.1440p.mkv", resolution: "1440p" },
    { filename: "Show.S01E02.2K.mkv", resolution: "1440p" },
    { filename: "Show.S01E02.1080p.mkv", resolution: "1080p" },
    { filename: "Show.S01E02.FHD.mkv", resolution: "1080p" },
    { filename: "Show.S01E02.720p.mkv", resolution: "720p" },
    { filename: "Show.S01E02.480p.mkv", resolution: "480p" },
    {
      filename: "Show.S01E02.WEB-DL.mkv",
      resolution: null,
    },
  ];

  test.each(resolutions)(
    "normalizes the resolution tag in $filename",
    ({ filename, resolution }) => {
      const parsed = parseVideoCandidate(remoteFile({ originalFilename: filename }));
      expect(parsed?.resolution ?? null).toBe(resolution);
      expect(parsed?.resolutionHeight ?? null).toBe(
        resolution === null ? null : Number.parseInt(resolution, 10),
      );
    },
  );

  const multiEpisode: Array<{
    filename: string;
    episode: number;
    episodeEnd: number;
    episodeTitle?: string | null;
  }> = [
    { filename: "Show.S01E02E03.1080p.mkv", episode: 2, episodeEnd: 3 },
    { filename: "Show.S01E02-E03.1080p.mkv", episode: 2, episodeEnd: 3 },
    { filename: "Show.S01E02.E03.1080p.mkv", episode: 2, episodeEnd: 3 },
    { filename: "Show.S01E02-E04.mkv", episode: 2, episodeEnd: 4 },
    {
      filename: "Show - S01E02-E03 - Two Parter.mkv",
      episode: 2,
      episodeEnd: 3,
      episodeTitle: "Two Parter",
    },
  ];

  test.each(multiEpisode)(
    "detects the multi-episode range in $filename",
    ({ filename, episode, episodeEnd, episodeTitle }) => {
      const parsed = parseVideoCandidate(remoteFile({ originalFilename: filename }));
      expect(parsed).toMatchObject({
        season: 1,
        episode,
        episodeEnd,
        multiEpisode: true,
      });
      if (episodeTitle !== undefined) {
        expect(parsed?.episodeTitle).toBe(episodeTitle);
      }
    },
  );

  test("keeps single episodes non-multi-episode", () => {
    const parsed = parseVideoCandidate(
      remoteFile({ originalFilename: "Show.S01E02.1080p.mkv" }),
    );
    expect(parsed).toMatchObject({
      episode: 2,
      episodeEnd: null,
      multiEpisode: false,
    });
  });

  const rejected: Array<{ label: string; file: Partial<RemoteFile> }> = [
    {
      label: "absolute remote path",
      file: {
        originalFilename: "Show.S01E02.1080p.mkv",
        remotePath: "/media/Show.S01E02.1080p.mkv",
      },
    },
    {
      label: "absolute Windows remote path",
      file: {
        originalFilename: "Show.S01E02.1080p.mkv",
        remotePath: "C:\\Media\\Show.S01E02.1080p.mkv",
      },
    },
    {
      label: "traversal remote path",
      file: {
        originalFilename: "Show.S01E02.1080p.mkv",
        remotePath: "../../outside/Show.S01E02.1080p.mkv",
      },
    },
    {
      label: "traversal Windows remote path",
      file: {
        originalFilename: "Show.S01E02.1080p.mkv",
        remotePath: "..\\outside\\Show.S01E02.1080p.mkv",
      },
    },
    {
      label: "NUL byte in the filename",
      file: { originalFilename: "Show\u0000.S01E02.1080p.mkv" },
    },
    {
      label: "NUL byte in the remote path",
      file: {
        originalFilename: "Show.S01E02.1080p.mkv",
        remotePath: "Show\u0000/S01E02.mkv",
      },
    },
    { label: "archive extension", file: { originalFilename: "Show.S01E02.1080p.rar" } },
    { label: "transport stream extension", file: { originalFilename: "Show.S01E02.1080p.ts" } },
    { label: "metadata extension", file: { originalFilename: "Show.S01E02.nfo" } },
    { label: "subtitle extension", file: { originalFilename: "Show.S01E02.en.srt" } },
    { label: "disc image extension", file: { originalFilename: "Show.S01E02.iso" } },
    { label: "no extension", file: { originalFilename: "Show.S01E02.1080p" } },
    {
      label: "partial download",
      file: { originalFilename: "Show.S01E02.1080p.mkv.part" },
    },
    { label: "sample marker", file: { originalFilename: "Show.S01E02.sample.mkv" } },
    {
      label: "sample marker with resolution",
      file: { originalFilename: "Show.S01E02.Sample.1080p.mkv" },
    },
    {
      label: "plural sample marker",
      file: { originalFilename: "Show.S01E02.Samples.1080p.mkv" },
    },
    { label: "trailer marker", file: { originalFilename: "Show.S01E02.Trailer.mkv" } },
    {
      label: "featurette marker",
      file: { originalFilename: "Show.S01E02.Featurette.1080p.mkv" },
    },
    {
      label: "extras marker",
      file: { originalFilename: "Show.S01E02.Extras.1080p.mkv" },
    },
    {
      label: "singular extra marker",
      file: { originalFilename: "Show.S01E02.Extra.1080p.mkv" },
    },
    {
      label: "remote release with an extras word but no canonical title separator",
      file: { originalFilename: "Show - S01E02 Trailer.mkv" },
    },
    {
      label: "remote release whose episode title starts with an extras word",
      file: { originalFilename: "Show.S01E02.Trailer.Park.Boys.mkv" },
    },
    {
      label: "remote release whose episode title mixes extras words",
      file: { originalFilename: "Show.S01E02.Deleted.Extras.and.Featurette.mkv" },
    },
    {
      label: "canonical-shaped remote name with a sample title",
      file: { originalFilename: "Show - S01E02 - Sample.mkv" },
    },
    {
      label: "canonical-shaped remote name with a trailer title",
      file: { originalFilename: "Show - S01E02 - Trailer.mkv" },
    },
    {
      label: "canonical-shaped remote name with a featurette title",
      file: { originalFilename: "Show - S01E02 - Featurette.mkv" },
    },
    {
      label: "canonical-shaped remote name with an extras title",
      file: { originalFilename: "Show - S01E02 - Extras.mkv" },
    },
    {
      label: "canonical-shaped remote multi-episode name with a featurettes title",
      file: { originalFilename: "Show - S01E02-E03 - Featurettes.mkv" },
    },
    {
      label: "season above the cap",
      file: { originalFilename: "Show.S100E01.1080p.mkv" },
    },
    {
      label: "episode above the cap",
      file: { originalFilename: "Show.S01E1000.1080p.mkv" },
    },
    {
      label: "NxM season above the cap",
      file: { originalFilename: "Show.100x01.1080p.mkv" },
    },
    {
      label: "NxM episode above the cap",
      file: { originalFilename: "Show.1x1000.1080p.mkv" },
    },
    {
      label: "no episode marker at all",
      file: { originalFilename: "Show.1080p.WEB-DL.mkv" },
    },
    {
      label: "resolution noise instead of an episode marker",
      file: { originalFilename: "Show.1920x1080.mkv" },
    },
  ];

  test.each(rejected)("rejects $label", ({ file }) => {
    expect(parseVideoCandidate(remoteFile(file))).toBeNull();
  });

  test("normalizes an unknown or negative size to null", () => {
    expect(
      parseVideoCandidate(remoteFile({ bytes: null }))?.bytes,
    ).toBeNull();
    expect(
      parseVideoCandidate(remoteFile({ bytes: -5 }))?.bytes,
    ).toBeNull();
  });

  test("allowlists only video container extensions", () => {
    expect(videoExtensions).toContain("mkv");
    expect(videoExtensions).toContain("mp4");
    expect(videoExtensions).not.toContain("ts");
    expect(videoExtensions).not.toContain("part");
    expect(videoExtensions).not.toContain("srt");
  });
});
