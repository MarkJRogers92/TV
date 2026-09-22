import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { Schedule } from "../../web/pages/Schedule";

test("generates a selected date and shows EPG fields, diagnostics, and export path", async () => {
  const generated = {
    schedule: {
      id: "schedule",
      channelId: "marktv-laughs",
      date: "2026-09-18",
      timezone: "America/Chicago",
      diagnostics: [{ code: "FALLBACK_POOL", message: "Fallback used" }],
      entries: [
        {
          id: "entry",
          localStart: "20:00",
          localEnd: "21:30",
          kind: "movie",
          title: "The Wacky Weekend Movie",
          source: "friday-movie",
          sourceDaypartId: "late-night",
          sourceSlotId: "friday-movie",
          selectionExplanation: "Selected chronological next episode",
        },
      ],
    },
    exportPath: "/tmp/marktv-laughs.marktv.json",
  };
  const client = {
    latestSchedule: vi.fn(async () => null),
    generateSchedule: vi.fn(async () => generated),
  };
  render(
    <Schedule
      client={client as never}
      channelId="marktv-laughs"
      today="2026-09-18"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Generate schedule" }));

  expect(
    await screen.findByRole("table", { name: "Electronic program guide" }),
  ).toBeVisible();
  expect(screen.getByText("20:00")).toBeVisible();
  expect(screen.getByText("movie")).toBeVisible();
  expect(screen.getByText("The Wacky Weekend Movie")).toBeVisible();
  expect(screen.getByText("friday-movie")).toBeVisible();
  expect(screen.getByText("late-night")).toBeVisible();
  expect(screen.getByText("Selected chronological next episode")).toBeVisible();
  expect(screen.getByText("Fallback used")).toBeVisible();
  expect(screen.getByText("/tmp/marktv-laughs.marktv.json")).toBeVisible();
  await waitFor(() =>
    expect(client.generateSchedule).toHaveBeenCalledWith(
      "marktv-laughs",
      "2026-09-18",
    ),
  );
});

test("loads the schedule for the broadcast date the page is showing", async () => {
  const client = {
    latestSchedule: vi.fn(async (_channelId: string, date?: string) => ({
      id: `schedule-${date}`,
      channelId: "marktv-laughs",
      date,
      timezone: "America/Chicago",
      diagnostics: [],
      entries: [],
    })),
    generateSchedule: vi.fn(),
  };
  const { container } = render(
    <Schedule
      client={client as never}
      channelId="marktv-laughs"
      today="2026-09-18"
    />,
  );

  expect(await screen.findByText("2026-09-18 · America/Chicago")).toBeVisible();
  expect(client.latestSchedule).toHaveBeenCalledWith(
    "marktv-laughs",
    "2026-09-18",
  );

  // Moving the date must re-read THAT date: the page is a view of one
  // broadcast day, and "the newest row" is tomorrow's during the quiet hours.
  fireEvent.change(
    container.querySelector("input[type=date]") as HTMLInputElement,
    { target: { value: "2026-09-19" } },
  );
  expect(await screen.findByText("2026-09-19 · America/Chicago")).toBeVisible();
  expect(client.latestSchedule).toHaveBeenLastCalledWith(
    "marktv-laughs",
    "2026-09-19",
  );
});
