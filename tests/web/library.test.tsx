import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Library } from "../../web/pages/Library";

afterEach(cleanup);

test("adds and scans roots, repairs metadata, and assigns media to a pool", async () => {
  const item = {
    id: "episode",
    source: "local-folder",
    path: "/media/episode.mp4",
    kind: "episode",
    title: "Pilot",
    durationMs: null,
    durationStatus: "missing",
    available: false,
    tags: [],
  };
  const root = {
    id: "root",
    path: "/media",
    diagnostics: [],
    lastScannedAt: null,
  };
  const client = {
    listMediaRoots: vi.fn(async () => []),
    listMedia: vi.fn(async () => [item]),
    listPools: vi.fn(async () => [
      {
        id: "sitcoms",
        name: "Sitcoms",
        kinds: ["episode"],
        mediaIds: [],
        mode: "chronological",
        noRepeatMinutes: 60,
        weight: 1,
      },
    ]),
    addMediaRoot: vi.fn(async () => root),
    scanMediaRoot: vi.fn(async () => ({
      root: {
        ...root,
        lastScannedAt: "now",
        diagnostics: [
          {
            code: "MISSING_DURATION",
            path: item.path,
            message: "Missing duration",
          },
        ],
      },
      result: { items: [item], diagnostics: [] },
    })),
    updateMedia: vi.fn(async (value) => value),
    updatePool: vi.fn(async (value) => value),
    removeMediaRoot: vi.fn(),
  };
  render(<Library client={client as never} />);
  fireEvent.change(await screen.findByLabelText("Local media folder"), {
    target: { value: "/media" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add folder" }));
  expect(await screen.findByText("/media")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Scan folder" }));
  expect(await screen.findByText("Missing duration")).toBeVisible();
  fireEvent.change(screen.getByLabelText("Title for Pilot"), {
    target: { value: "Pilot repaired" },
  });
  fireEvent.change(screen.getByLabelText("Duration milliseconds for Pilot"), {
    target: { value: "1380000" },
  });
  fireEvent.change(screen.getByLabelText("Pool for Pilot"), {
    target: { value: "sitcoms" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save Pilot" }));
  await waitFor(() =>
    expect(client.updateMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Pilot repaired",
        durationMs: 1380000,
        durationStatus: "ok",
        available: true,
      }),
    ),
  );
  expect(client.updatePool).toHaveBeenCalledWith(
    expect.objectContaining({ id: "sitcoms", mediaIds: ["episode"] }),
  );
});

test("creates, edits, validates, and deletes pools", async () => {
  const existing = {
    id: "sitcoms",
    name: "Sitcoms",
    kinds: ["episode"],
    mediaIds: ["episode"],
    mode: "chronological",
    noRepeatMinutes: 60,
    weight: 1,
  };
  const client = {
    listMediaRoots: vi.fn(async () => []),
    listMedia: vi.fn(async () => []),
    listPools: vi.fn(async () => [existing]),
    createPool: vi.fn(async (pool) => pool),
    updatePool: vi
      .fn()
      .mockRejectedValueOnce({
        issues: [{ path: "mediaIds", message: "Media item is missing" }],
      })
      .mockImplementation(async (pool) => pool),
    removePool: vi.fn(),
  };
  render(<Library client={client as never} />);

  fireEvent.change(await screen.findByLabelText("New pool ID"), {
    target: { value: "movies" },
  });
  fireEvent.change(screen.getByLabelText("New pool name"), {
    target: { value: "Movies" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create pool" }));
  await waitFor(() =>
    expect(client.createPool).toHaveBeenCalledWith(
      expect.objectContaining({ id: "movies", name: "Movies", weight: 1 }),
    ),
  );

  fireEvent.change(screen.getByLabelText("Pool name for sitcoms"), {
    target: { value: "Comedy rotation" },
  });
  fireEvent.change(screen.getByLabelText("Selection mode for sitcoms"), {
    target: { value: "shuffle" },
  });
  fireEvent.change(screen.getByLabelText("No-repeat minutes for sitcoms"), {
    target: { value: "90" },
  });
  fireEvent.change(screen.getByLabelText("Weight for sitcoms"), {
    target: { value: "3" },
  });
  fireEvent.change(screen.getByLabelText("Media IDs for sitcoms"), {
    target: { value: "episode, episode-2" },
  });
  fireEvent.click(screen.getByLabelText("movie allowed in sitcoms"));
  fireEvent.click(screen.getByRole("button", { name: "Save pool sitcoms" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "mediaIds: Media item is missing",
  );
  fireEvent.click(screen.getByRole("button", { name: "Save pool sitcoms" }));
  await waitFor(() =>
    expect(client.updatePool).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "sitcoms",
        name: "Comedy rotation",
        mode: "shuffle",
        noRepeatMinutes: 90,
        weight: 3,
        kinds: ["episode", "movie"],
        mediaIds: ["episode", "episode-2"],
      }),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete pool sitcoms" }));
  await waitFor(() =>
    expect(client.removePool).toHaveBeenCalledWith("sitcoms"),
  );
});
