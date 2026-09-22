import { describe, expect, test, vi } from "vitest";
import type { MediaItem } from "../../src/domain/models.js";
import { confirmContinuityMedia, insideLibrary } from "../../src/continuity/library.js";

const media = [{ id: "card", path: "/library/generated/continuity/card.mp4" }] as MediaItem[];
const entry = { id: "tunarr-card", path: media[0].path!, program: {} };
const libraries = [{ sourceId: "source", id: "library", path: "/library" }];

describe("continuity playback inventory", () => {
  test("requires actual path containment, not a prefix sibling", () => {
    expect(insideLibrary("/library", media[0].path!)).toBe(true);
    expect(insideLibrary("/library", "/library-old/card.mp4")).toBe(false);
    expect(insideLibrary("/library", "/library/../elsewhere/card.mp4")).toBe(false);
  });
  test("does not scan already playable cards", async () => {
    const client = { inventory: vi.fn().mockResolvedValue([entry]), scanLibrary: vi.fn() };
    expect(await confirmContinuityMedia({ client, libraries }, media)).toEqual(media);
    expect(client.scanLibrary).not.toHaveBeenCalled();
  });
  test("scans once then accepts a newly indexed playable card", async () => {
    const client = {
      inventory: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([entry]),
      scanLibrary: vi.fn().mockResolvedValue(true),
    };
    expect(await confirmContinuityMedia({ client, libraries }, media, async () => {})).toEqual(media);
    expect(client.scanLibrary).toHaveBeenCalledTimes(1);
    expect(client.inventory).toHaveBeenCalledTimes(2);
  });
  test.each([
    { inventory: [] },
    { inventory: [{ ...entry, program: { state: "missing" } }] },
    { inventory: [entry, entry] },
  ])("rejects missing, unusable or ambiguous cards after one scan", async ({ inventory }) => {
    const client = { inventory: vi.fn().mockResolvedValue(inventory), scanLibrary: vi.fn().mockResolvedValue(true) };
    expect(await confirmContinuityMedia({ client, libraries }, media, async () => {})).toEqual([]);
    expect(client.scanLibrary).toHaveBeenCalledTimes(1);
  });
  test("allows one final bounded inventory check for a slower offline scan", async () => {
    const client = {
      inventory: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([entry]),
      scanLibrary: vi.fn().mockResolvedValue(true),
    };
    const settle = vi.fn().mockResolvedValue(undefined);
    expect(await confirmContinuityMedia({ client, libraries }, media, settle)).toEqual(media);
    expect(client.scanLibrary).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(2);
  });
});
