import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { MovieProgrammingPanel } from "../../web/components/MovieProgrammingPanel";
import type { MovieProgrammingStatus } from "../../web/types";

afterEach(cleanup);

const off: MovieProgrammingStatus = {
  channelId: "marktv-laughs",
  enabled: false,
  upcoming: [],
  degraded: [],
};

const on: MovieProgrammingStatus = {
  channelId: "marktv-laughs",
  enabled: true,
  poolIds: ["movies"],
  rootPath: "/Volumes/SSK Drive /MarkTV/Movies",
  rootAvailable: true,
  movieCount: 29,
  lookaheadDays: 8,
  upcoming: [
    {
      date: "2026-09-12",
      position: "nightly",
      role: "nightly",
      anchor: "02:00",
      mediaId: "movie-01",
      title: "Movie 1",
      encore: false,
      available: true,
      consumes: true,
    },
    {
      date: "2026-09-13",
      position: "nightly",
      role: "encore",
      anchor: "02:00",
      mediaId: "movie-04",
      title: "Movie 4",
      encore: true,
      available: true,
      consumes: false,
    },
  ],
  degraded: ["Only one movie is eligible, so consecutive airings must repeat it"],
};

test("shows the feature as off and turns it on with an explicit pool and folder", async () => {
  const client = {
    movieProgrammingStatus: vi
      .fn()
      .mockResolvedValueOnce(off)
      .mockResolvedValue(on),
    setMovieProgramming: vi.fn(async () => ({})),
  };
  render(<MovieProgrammingPanel client={client as never} />);

  expect(await screen.findByText("Off")).toBeVisible();
  // Enabling sends a complete configuration, never the flag alone: a feature with
  // no pool and no folder can never schedule anything.
  fireEvent.change(screen.getByLabelText(/Movie folder/i), {
    target: { value: "/Volumes/SSK Drive /MarkTV/Movies" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Turn movie programming on" }),
  );

  await waitFor(() =>
    expect(client.setMovieProgramming).toHaveBeenCalledWith("marktv-laughs", {
      enabled: true,
      poolIds: ["movies"],
      rootPath: "/Volumes/SSK Drive /MarkTV/Movies",
    }),
  );
  expect(await screen.findByText("On")).toBeVisible();
  expect(screen.getByText(/\/Volumes\/SSK Drive \/MarkTV\/Movies/)).toBeVisible();
  expect(screen.getByText(/29 movies/)).toBeVisible();
  await waitFor(() =>
    expect(client.movieProgrammingStatus).toHaveBeenCalledTimes(2),
  );
});

test("refuses to enable with no folder to scan instead of sending an empty one", async () => {
  const client = {
    movieProgrammingStatus: vi.fn(async () => off),
    setMovieProgramming: vi.fn(async () => ({})),
  };
  render(<MovieProgrammingPanel client={client as never} />);
  await screen.findByText("Off");
  fireEvent.click(
    screen.getByRole("button", { name: "Turn movie programming on" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    /Movies folder|needs the pool/i,
  );
  expect(client.setMovieProgramming).not.toHaveBeenCalled();
});

test("lists upcoming airings, marks encores, and shows degraded notices", async () => {
  const client = { movieProgrammingStatus: vi.fn(async () => on) };
  render(<MovieProgrammingPanel client={client as never} />);

  expect(await screen.findByText("Upcoming movies")).toBeVisible();
  // Matched on the list item itself: the text query would otherwise also match the
  // list and the section that contain it.
  const airings = screen
    .getAllByRole("listitem")
    .map((item) => item.textContent ?? "");
  expect(
    airings.some((text) => text.includes("2026-09-12 02:00") && text.includes("Movie 1")),
  ).toBe(true);
  expect(airings.some((text) => text.includes("Movie 4 (encore)"))).toBe(true);
  expect(
    airings.some((text) => text.includes("consecutive airings must repeat it")),
  ).toBe(true);
});

test("reports a failed request instead of pretending it worked", async () => {
  const client = {
    movieProgrammingStatus: vi.fn(async () => off),
    setMovieProgramming: vi.fn(async () => {
      throw Object.assign(new Error("Movie programming is invalid"), {
        issues: [{ path: "movieProgramming.poolIds", message: "Pool is missing" }],
      });
    }),
  };
  render(<MovieProgrammingPanel client={client as never} />);
  await screen.findByText("Off");
  fireEvent.change(screen.getByLabelText(/Movie folder/i), {
    target: { value: "/Volumes/Media/Movies" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Turn movie programming on" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "movieProgramming.poolIds: Pool is missing",
  );
});

test("renders nothing for a client that has no movie-programming methods", () => {
  const { container } = render(
    <MovieProgrammingPanel client={{ latestSchedule: vi.fn() } as never} />,
  );
  expect(container).toBeEmptyDOMElement();
});
