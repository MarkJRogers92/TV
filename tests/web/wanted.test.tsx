import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Wanted } from "../../web/pages/Wanted";

afterEach(cleanup);

const wantedEntry = {
  id: "wanted-1",
  seriesTitle: "Example Show",
  season: 1,
  episode: 2,
  episodeTitle: "Pilot",
  status: "downloading",
  statusDetail: null,
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-14T00:00:00.000Z",
  stremioUrl: "stremio:///search?search=Example%20Show%20S01E02%20Pilot",
  job: {
    id: "job-1",
    state: "downloading",
    provider: "real-debrid",
    attempt: 1,
    maxAttempts: 3,
    expectedBytes: 1000,
    receivedBytes: 250,
    retryAfterMs: null,
    cancelRequested: false,
    updatedAt: "2026-09-14T00:00:00.000Z",
  },
  review: {
    id: "review-1",
    kind: "ambiguous",
    message: "Multiple files match this episode.",
    candidateCount: 2,
    candidates: [
      { candidateIndex: 0, provider: "real-debrid", filename: "A.Show.S01E02.720p.candidate-a.mkv", sizeBytes: 1000, resolution: "720p" },
      { candidateIndex: 1, provider: "real-debrid", filename: "A.Show.S01E02.720p.candidate-b.mkv", sizeBytes: 1200, resolution: "720p" },
    ],
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
  },
};

const pack = {
  id: "pack-1",
  provider: "real-debrid",
  seriesTitle: "Example Show",
  season: 1,
  episodeCount: 2,
  totalBytes: 2000,
  message: "Season pack offer for Example Show season 1.",
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-14T00:00:00.000Z",
  episodes: [
    { episode: 1, sizeBytes: 1000, resolution: "1080p", status: "imported" },
    { episode: 2, sizeBytes: 1000, resolution: null, status: "wanted" },
  ],
};

function stubClient(overrides = {}) {
  return {
    listWanted: async () => [{ ...wantedEntry }],
    listSeasonPacks: async () => [{ ...pack }],
    addWanted: async (input: unknown) => ({ ...wantedEntry, id: "wanted-2", ...(input as object), stremioUrl: "stremio:///search?search=New", job: null, review: null }),
    removeWanted: async () => ({ ...wantedEntry }),
    retryJob: async () => ({ status: "queued", job: wantedEntry.job }),
    cancelJob: async () => ({ status: "cancelled", job: wantedEntry.job }),
    importSeason: async () => ({ status: "scheduled", wantedIds: ["w-1"], jobIds: ["j-1"], alreadyImported: 0, alreadyScheduled: 0 }),
    ...overrides,
  };
}

test("wanted list shows status, progress, review, exact Stremio link, and job actions", async () => {
  render(<Wanted client={stubClient() as never} />);
  expect(await screen.findByText("Wanted episodes (1)")).toBeVisible();
  expect(screen.getAllByText("Downloading").length).toBeGreaterThan(0);
  expect(screen.getByText(/250 B of 1000 B \(25%\)/)).toBeVisible();
  expect(screen.getByText(/Multiple files match this episode/)).toBeVisible();
  const link = screen.getByRole("link", { name: "Open in Stremio" });
  expect(link.getAttribute("href")).toBe(wantedEntry.stremioUrl);
  expect(screen.getByRole("button", { name: "Retry job" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Cancel job" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Remove episode" })).toBeVisible();
});

test("candidate choices remain unselected until the user deliberately selects one and sends its review version", async () => {
  const selectCandidate = vi.fn(async () => ({ status: "scheduled", job: wantedEntry.job }));
  render(<Wanted client={stubClient({ selectCandidate }) as never} />);
  await screen.findByText("Wanted episodes (1)");
  expect(screen.getByLabelText("Select A.Show.S01E02.720p.candidate-a.mkv")).toBeVisible();
  expect(screen.getByRole("button", { name: "Use selected candidate" })).toBeDisabled();
  fireEvent.click(screen.getByLabelText("Select A.Show.S01E02.720p.candidate-b.mkv"));
  fireEvent.click(screen.getByRole("button", { name: "Use selected candidate" }));
  await screen.findByText(/Candidate selected/);
  expect(selectCandidate).toHaveBeenCalledWith("review-1", {
    candidateIndex: 1,
    reviewUpdatedAt: "2026-09-14T00:00:00.000Z",
  });
});

test("resets a prior candidate choice when its review is refreshed", async () => {
  const refreshed = {
    ...wantedEntry,
    review: {
      ...wantedEntry.review,
      updatedAt: "2026-09-14T00:05:00.000Z",
      candidates: [wantedEntry.review.candidates[0]],
    },
  };
  const listWanted = vi.fn()
    .mockResolvedValueOnce([{ ...wantedEntry }])
    .mockResolvedValueOnce([refreshed]);
  render(<Wanted client={stubClient({ listWanted }) as never} />);
  await screen.findByText("Wanted episodes (1)");
  fireEvent.click(screen.getByLabelText("Select A.Show.S01E02.720p.candidate-b.mkv"));
  expect(screen.getByRole("button", { name: "Use selected candidate" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Retry job" }));
  await waitFor(() => expect(screen.queryByLabelText("Select A.Show.S01E02.720p.candidate-b.mkv")).toBeNull());
  expect(screen.getByRole("button", { name: "Use selected candidate" })).toBeDisabled();
});

test("does not offer selection controls for a multi-episode review", async () => {
  const multiEpisode = {
    ...wantedEntry,
    review: { ...wantedEntry.review, kind: "multi-episode" },
  };
  render(<Wanted client={stubClient({ listWanted: async () => [multiEpisode] }) as never} />);
  await screen.findByText("Wanted episodes (1)");
  expect(screen.getByText(/cannot be selected as a single episode/i)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Use selected candidate" })).toBeNull();
});

test("does not turn blank season or episode inputs into episode zero", async () => {
  const addWanted = vi.fn(async () => ({ ...wantedEntry, id: "wanted-blank" }));
  render(<Wanted client={stubClient({ addWanted }) as never} />);
  await screen.findByText("Wanted episodes (1)");
  fireEvent.change(screen.getByLabelText("Series title"), { target: { value: "New Show" } });
  fireEvent.change(screen.getByLabelText("Season"), { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "Add episode" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Enter a series title, season, and episode.");
  expect(addWanted).not.toHaveBeenCalled();
});

test("season packs show count, bytes, status, and import action", async () => {
  render(<Wanted client={stubClient() as never} />);
  expect(await screen.findByText(/1 season pack offer/)).toBeVisible();
  expect(screen.getByText(/2 episode\(s\)/)).toBeVisible();
  expect(screen.getByText("Imported")).toBeVisible();
  expect(screen.getByRole("button", { name: "Import Season 1" })).toBeVisible();
});

test("competing collections require an explicit requested-season import choice", async () => {
  const importSeason = vi.fn(async () => ({ status: "scheduled", wantedIds: ["w-1"], jobIds: ["j-1"], alreadyImported: 0, alreadyScheduled: 0 }));
  render(<Wanted client={stubClient({
    importSeason,
    listSeasonPacks: async () => [
      { ...pack, id: "collection-a", seriesTitle: "Roseanne", season: 1, message: "Season collection A" },
      { ...pack, id: "collection-b", seriesTitle: "Roseanne", season: 1, message: "Season collection B" },
    ],
  }) as never} />);

  expect(await screen.findByText(/Choose one Roseanne collection for Season 1/i)).toBeVisible();
  const buttons = screen.getAllByRole("button", { name: "Import Season 1" });
  expect(buttons).toHaveLength(2);
  fireEvent.click(buttons[1]!);
  await waitFor(() => expect(importSeason).toHaveBeenCalledWith("collection-b"));
});

test("add form submits human metadata and remove reports conflicts safely", async () => {
  const addWanted = vi.fn(async () => ({ ...wantedEntry, id: "wanted-9" }));
  const removeWanted = vi.fn(async () => {
    throw Object.assign(new Error("Cancel the active acquisition job for this episode before removing it"), { code: "ACTIVE_JOB" });
  });
  render(<Wanted client={stubClient({ addWanted, removeWanted }) as never} />);
  await screen.findByText("Wanted episodes (1)");
  fireEvent.change(screen.getByLabelText("Series title"), { target: { value: "New Show" } });
  fireEvent.change(screen.getByLabelText("Season"), { target: { value: "2" } });
  fireEvent.change(screen.getByLabelText("Episode"), { target: { value: "3" } });
  fireEvent.click(screen.getByRole("button", { name: "Add episode" }));
  await screen.findByText(/Added Example Show/);
  expect(addWanted).toHaveBeenCalledWith({ seriesTitle: "New Show", season: 2, episode: 3, episodeTitle: null });
  fireEvent.click(screen.getAllByRole("button", { name: "Remove episode" })[0]);
  const alerts = await screen.findAllByRole("alert");
  const conflict = alerts.find((entry) => entry.textContent?.includes("Cancel the active acquisition job"));
  expect(conflict).toBeDefined();
  expect(within(conflict as HTMLElement).queryByRole("link")).toBeNull();
});

test("retry and import actions refresh safely and never render tokens or paths", async () => {
  const retryJob = vi.fn(async () => ({ status: "queued", job: wantedEntry.job }));
  const importSeason = vi.fn(async () => ({ status: "scheduled", wantedIds: ["w-1"], jobIds: [], alreadyImported: 0, alreadyScheduled: 0 }));
  const { container } = render(<Wanted client={stubClient({ retryJob, importSeason }) as never} />);
  await screen.findByText("Wanted episodes (1)");
  fireEvent.click(screen.getByRole("button", { name: "Retry job" }));
  await screen.findByText(/Retry queued/);
  expect(retryJob).toHaveBeenCalledWith("job-1");
  fireEvent.click(screen.getByRole("button", { name: "Import Season 1" }));
  await screen.findByText(/Season import scheduled/);
  expect(importSeason).toHaveBeenCalledWith("pack-1");
  expect(container.innerHTML).not.toMatch(/token|downloadUrl|signedUrl|partPath|destinationPath|bearer/i);
});

test("refreshes only active acquisition projections without overlap and cleans up", async () => {
  vi.useFakeTimers();
  let release!: (value: typeof wantedEntry[]) => void;
  const delayed = new Promise<typeof wantedEntry[]>((resolve) => { release = resolve; });
  const listWanted = vi.fn()
    .mockResolvedValueOnce([{ ...wantedEntry }])
    .mockReturnValueOnce(delayed);
  const listSeasonPacks = vi.fn()
    .mockResolvedValueOnce([{ ...pack }])
    .mockResolvedValueOnce([{ ...pack }]);
  const view = render(<Wanted client={stubClient({ listWanted, listSeasonPacks }) as never} />);
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByText("Wanted episodes (1)")).toBeVisible();
  expect(listWanted).toHaveBeenCalledTimes(1);
  act(() => { vi.advanceTimersByTime(5_000); });
  await act(async () => { await Promise.resolve(); });
  expect(listWanted).toHaveBeenCalledTimes(2);
  act(() => { vi.advanceTimersByTime(10_000); });
  await act(async () => { await Promise.resolve(); });
  expect(listWanted).toHaveBeenCalledTimes(2);
  await act(async () => { release([{ ...wantedEntry }]); });
  view.unmount();
  act(() => { vi.advanceTimersByTime(10_000); });
  expect(listWanted).toHaveBeenCalledTimes(2);
  expect(listSeasonPacks).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});

test("does not arm the refresh timer when every Wanted item is terminal", async () => {
  vi.useFakeTimers();
  const listWanted = vi.fn(async () => [{ ...wantedEntry, status: "imported", job: { ...wantedEntry.job, state: "imported" } }]);
  const listSeasonPacks = vi.fn(async () => [{ ...pack }]);
  render(<Wanted client={stubClient({ listWanted, listSeasonPacks }) as never} />);
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByText("Wanted episodes (1)")).toBeVisible();
  act(() => { vi.advanceTimersByTime(15_000); });
  expect(listWanted).toHaveBeenCalledTimes(1);
  expect(listSeasonPacks).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});
