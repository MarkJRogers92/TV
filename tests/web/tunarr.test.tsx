import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Tunarr } from "../../web/pages/Tunarr";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
test("shows Test, dry-run, and guarded Sync states without using an untyped result", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        url: "http://fake",
        version: "1",
        supportsProgramming: true,
      }),
      { status: 200 },
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  render(<Tunarr />);
  const sync = screen.getByRole("button", { name: "Sync" });
  expect(sync).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  await waitFor(() =>
    expect(screen.getByText(/Connected: Tunarr 1/)).toBeVisible(),
  );
  fetcher.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        syncEligible: true,
        capabilities: { version: "1" },
        blockingErrors: [],
        warnings: [],
        matchCounts: { matched: 2, unmatched: 0, ambiguous: 0, placeholder: 0 },
        operations: [{ type: "programming" }],
      }),
      { status: 200 },
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Dry run" }));
  await waitFor(() => expect(sync).toBeEnabled());
  fireEvent.change(screen.getByLabelText("Library ID"), {
    target: { value: "changed" },
  });
  expect(sync).toBeDisabled();
});

test("sends channel creation inputs and invalidates an eligible dry run on edits", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        syncEligible: true,
        capabilities: { version: "1" },
        blockingErrors: [],
        warnings: [],
        matchCounts: { matched: 3, unmatched: 0, ambiguous: 0, placeholder: 0 },
        operations: [
          { type: "channel-create" },
          { type: "filler-create" },
          { type: "programming" },
        ],
      }),
      { status: 200 },
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  render(<Tunarr />);
  fireEvent.change(screen.getByLabelText("Library ID"), {
    target: { value: "lib" },
  });
  fireEvent.click(screen.getByLabelText("Create a new Tunarr channel"));
  fireEvent.change(screen.getByLabelText("Transcode configuration ID"), {
    target: { value: "transcode-id" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Dry run" }));
  await waitFor(() =>
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/v1/tunarr/dry-run",
      expect.objectContaining({
        body: JSON.stringify({
          url: "http://127.0.0.1:8000",
          libraryId: "lib",
          channelId: "",
          createChannel: true,
          transcodeConfigId: "transcode-id",
        }),
      }),
    ),
  );
  expect(
    screen.getByText(/channel-create, filler-create, programming/),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Sync" })).toBeEnabled();
  fireEvent.change(screen.getByLabelText("Transcode configuration ID"), {
    target: { value: "changed" },
  });
  expect(screen.getByRole("button", { name: "Sync" })).toBeDisabled();
});
