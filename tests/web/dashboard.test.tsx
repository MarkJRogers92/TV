import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { Dashboard } from "../../web/pages/Dashboard";

test("shows selected channel, current clock, preview status, and current programming", async () => {
  const client = {
    listChannels: async () => [
      {
        id: "marktv-laughs",
        name: "MarkTV Laughs",
        number: 7,
        timezone: "America/Chicago",
      },
    ],
    getAir: async () => ({
      channel: {
        id: "marktv-laughs",
        name: "MarkTV Laughs",
        number: 7,
        timezone: "America/Chicago",
      },
      currentTime: "2026-09-13T18:12:00-05:00",
      scheduleStatus: "Preview only",
      nowPlaying: { title: "Apartment 4B 1" },
      upNext: { title: "Space Neighbors 1" },
    }),
  };
  render(<Dashboard client={client as never} channelId="marktv-laughs" />);
  expect(await screen.findByText("MarkTV Laughs · Channel 7")).toBeVisible();
  expect(screen.getByText("Preview only")).toBeVisible();
  expect(screen.getByText(/Current time.*18:12/)).toBeVisible();
  expect(screen.getByRole("heading", { name: "Now Playing" })).toBeVisible();
  expect(screen.getByText("Apartment 4B 1")).toBeVisible();
  expect(screen.getByRole("heading", { name: "Up Next" })).toBeVisible();
});
