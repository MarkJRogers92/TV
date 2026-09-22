import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Continuity } from "../../web/pages/Continuity";
import type { ContinuityStatus } from "../../web/types";

afterEach(cleanup);

const status: ContinuityStatus = {
  channelId: "marktv-laughs",
  config: {
    enabled: true,
    nextCards: true,
    nextLaterFrequency: "normal",
    tonightFrequency: "normal",
    overnightWeirdness: "low",
    stagedInterruptionsEnabled: false,
    promoFrequency: 0.25,
    clipCooldownMinutes: 60,
    targetCooldownMinutes: 30,
    oddPersonaCooldownHours: 6,
    maximumSpokenElementsPerBreak: 2,
    maximumContinuitySecondsPerBreak: 20,
  },
  activation: {
    state: "enabled",
    reason: null,
    ready: true,
    canEnable: true,
  },
  branding: { state: "bound", expectedFile: "marktv-logo-canonical.png" },
  assets: { discovered: 22, airReady: 20, generated: 3, scriptOnly: 219, quarantined: 2 },
  voices: { network: 2, local: 8, overnight: 2, odd: 0, unclassified: 10 },
  director: {
    scheduleRevision: "revision-7",
    contentHash: "abcdef",
    label: "TONIGHT",
    current: "Roseanne",
    next: "Night Court",
    later: "Home Improvement",
    cards: [
      {
        cardType: "tonight",
        family: "prime-time",
        label: "TONIGHT",
        title: "Tremors",
        details: ["STARTS 7:30 PM"],
        durationMs: 10_000,
        insertionInstant: "2026-09-20T23:05:00.000Z",
        targetTitles: ["Tremors"],
        targetTimes: ["2026-09-21T00:30:00.000Z"],
        assetRegistered: false,
      },
    ],
    skippedReason: null,
  },
  preview: {
    scheduleRevision: "revision-7",
    insertionInstant: "2026-09-20T23:05:00.000Z",
    label: "TONIGHT",
    current: "Roseanne",
    next: "Night Court",
    later: "Home Improvement",
    selectedAsset: "marktv-up-next-night-court",
    skippedReason: null,
  },
};

test("shows director state, readiness and planned cards without claiming live playback", async () => {
  const client = { continuityStatus: vi.fn(async () => status), updateContinuity: vi.fn() };
  render(<Continuity channelId="marktv-laughs" client={client as never} />);

  expect(await screen.findByRole("heading", { name: "Continuity Director" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Director on" })).toBeVisible();
  expect(screen.queryByText(/^Live$/)).toBeNull();
  expect(screen.getByText(/Roseanne/)).toBeVisible();
  expect(screen.getByText(/Night Court/)).toBeVisible();
  expect(screen.getByText(/Tremors/)).toBeVisible();
  expect(screen.getByText(/3 schedule cards/)).toBeVisible();
  expect(screen.getByText(/awaiting offline render/)).toBeVisible();
  expect(screen.getByRole("checkbox", { name: /staged interruptions/i })).toBeDisabled();
});

test("saves the director controls through the existing continuity API", async () => {
  const updated = {
    ...status,
    config: { ...status.config, nextCards: false, tonightFrequency: "high" as const },
  };
  const client = {
    continuityStatus: vi.fn(async () => status),
    updateContinuity: vi.fn(async () => updated),
  };
  render(<Continuity channelId="marktv-laughs" client={client as never} />);
  await screen.findByRole("heading", { name: "Continuity Director" });

  fireEvent.click(screen.getByRole("checkbox", { name: /NEXT and NEXT\/LATER cards/i }));
  fireEvent.change(screen.getByLabelText(/TONIGHT card frequency/i), {
    target: { value: "high" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save continuity settings" }));
  await waitFor(() =>
    expect(client.updateContinuity).toHaveBeenCalledWith("marktv-laughs", {
      nextCards: false,
      tonightFrequency: "high",
    }),
  );
  expect(await screen.findByText(/settings saved/i)).toBeVisible();
  expect(screen.getByLabelText(/NEXT card frequency/i)).toHaveValue("normal");
});

test("can switch the director off and back on without touching playback controls", async () => {
  const off = {
    ...status,
    config: { ...status.config, enabled: false },
    activation: { state: "disabled" as const, reason: "Continuity is off.", ready: true, canEnable: true },
    director: { ...status.director, cards: [], skippedReason: "NO_ELIGIBLE_PLAN" },
  };
  const client = {
    continuityStatus: vi.fn().mockResolvedValueOnce(status).mockResolvedValue(off),
    updateContinuity: vi.fn(async () => off),
  };
  render(<Continuity channelId="marktv-laughs" client={client as never} />);
  await screen.findByRole("heading", { name: "Continuity Director" });
  fireEvent.click(screen.getByRole("checkbox", { name: /Plan continuity cards/i }));
  fireEvent.click(screen.getByRole("button", { name: "Save continuity settings" }));
  await waitFor(() =>
    expect(client.updateContinuity).toHaveBeenCalledWith("marktv-laughs", { enabled: false }),
  );
  expect(await screen.findByRole("heading", { name: "Director off" })).toBeVisible();
  expect(screen.getByText(/NO_ELIGIBLE_PLAN/)).toBeVisible();
});
