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
/**
 * The page reads /tunarr/status on mount so the last sync outcome is visible
 * without acting. Route that request separately, otherwise it consumes one of
 * the per-test queued responses the assertions below depend on.
 */
function stubTunarrFetch(fetcher: unknown) {
  vi.stubGlobal(
    "fetch",
    (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("/api/v1/tunarr/status")
        ? Promise.resolve(
            new Response(JSON.stringify({ configured: false }), { status: 200 }),
          )
        : (fetcher as (i: RequestInfo | URL, o?: RequestInit) => Promise<Response>)(input, init),
  );
}

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
  stubTunarrFetch(fetcher);
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
  fireEvent.change(screen.getByLabelText(/Library IDs/i), {
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
  stubTunarrFetch(fetcher);
  render(<Tunarr />);
  fireEvent.change(screen.getByLabelText(/Library IDs/i), {
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
          libraryIds: ["lib"],
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

test("accepts multiple library IDs one per line, trims/dedupes, and submits libraryIds", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        url: "http://fake",
        version: "1",
        supportsProgramming: true,
        supportsInventory: true,
      }),
      { status: 200 },
    ),
  );
  stubTunarrFetch(fetcher);
  render(<Tunarr />);
  const input = screen.getByLabelText(/Library IDs/i);
  expect(input.tagName.toLowerCase()).toBe("textarea");
  fireEvent.change(input, { target: { value: " lib-a \nlib-b\n lib-a \n\n" } });
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  await waitFor(() =>
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/v1/tunarr/test",
      expect.objectContaining({
        body: JSON.stringify({
          url: "http://127.0.0.1:8000",
          libraryIds: ["lib-a", "lib-b"],
          channelId: "",
        }),
      }),
    ),
  );
});

test("invalidates the prior dry run when library IDs are edited", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        syncEligible: true,
        capabilities: { version: "1" },
        blockingErrors: [],
        warnings: [],
        matchCounts: { matched: 1, unmatched: 0, ambiguous: 0, placeholder: 0 },
        operations: [{ type: "programming" }],
      }),
      { status: 200 },
    ),
  );
  stubTunarrFetch(fetcher);
  render(<Tunarr />);
  fireEvent.change(screen.getByLabelText(/Library IDs/i), {
    target: { value: "lib-a" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Dry run" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Sync" })).toBeEnabled(),
  );
  fireEvent.change(screen.getByLabelText(/Library IDs/i), {
    target: { value: "lib-a\nlib-b" },
  });
  expect(screen.getByRole("button", { name: "Sync" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Dry run" }));
  await waitFor(() =>
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/v1/tunarr/dry-run",
      expect.objectContaining({
        body: expect.stringContaining('"libraryIds":["lib-a","lib-b"]'),
      }),
    ),
  );
});

test("ignores an eligible dry run that finishes after library IDs change", async () => {
  let finishDryRun: ((response: Response) => void) | undefined;
  const fetcher = vi.fn().mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finishDryRun = resolve;
      }),
  );
  stubTunarrFetch(fetcher);
  render(<Tunarr />);

  fireEvent.change(screen.getByLabelText(/Library IDs/i), {
    target: { value: "lib-a" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Dry run" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

  fireEvent.change(screen.getByLabelText(/Library IDs/i), {
    target: { value: "lib-b" },
  });
  finishDryRun?.(
    new Response(
      JSON.stringify({
        syncEligible: true,
        capabilities: { version: "1" },
        blockingErrors: [],
        warnings: [],
        matchCounts: { matched: 1, unmatched: 0, ambiguous: 0, placeholder: 0 },
        operations: [{ type: "programming" }],
      }),
      { status: 200 },
    ),
  );

  await waitFor(() => expect(finishDryRun).toBeDefined());
  expect(screen.getByRole("button", { name: "Sync" })).toBeDisabled();
});
