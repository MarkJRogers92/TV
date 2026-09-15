import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Integrations } from "../../web/pages/Integrations";

afterEach(cleanup);

function stubClient(overrides = {}) {
  return {
    listIntegrations: async () => [
      { provider: "real-debrid", connected: true, accountLabel: "premium-user", error: null },
      { provider: "torbox", connected: false, accountLabel: null, error: { code: "NO_TOKEN", message: "No token saved for this provider. Save a token first." } },
    ],
    saveIntegrationToken: async (provider: string) => ({ provider, connected: false, accountLabel: null, error: null }),
    testIntegration: async (provider: string) => ({ provider, connected: true, accountLabel: "premium-user", error: null }),
    ...overrides,
  };
}

test("shows safe connection state and friendly errors without tokens", async () => {
  render(<Integrations client={stubClient() as never} />);
  expect(await screen.findByText("Real-Debrid")).toBeVisible();
  expect(screen.getByText("Connected")).toBeVisible();
  expect(screen.getByText("Account: premium-user")).toBeVisible();
  expect(screen.getByText("Not connected")).toBeVisible();
  expect(screen.getByText("No token saved for this provider. Save a token first.")).toBeVisible();
  const firstToken = screen.getByLabelText("Token for real-debrid") as HTMLInputElement;
  expect(firstToken.type).toBe("password");
  expect(firstToken.value).toBe("");
});

test("save clears the password input and test updates connection", async () => {
  const saveIntegrationToken = vi.fn(async (provider: string) => ({ provider, connected: false, accountLabel: null, error: null }));
  const testIntegration = vi.fn(async (provider: string) => ({ provider, connected: true, accountLabel: "premium-user", error: null }));
  render(<Integrations client={stubClient({ saveIntegrationToken, testIntegration }) as never} />);
  await screen.findByText("Real-Debrid");
  const input = screen.getByLabelText("Token for torbox") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "secret-token-value" } });
  fireEvent.click(screen.getAllByRole("button", { name: "Save token" })[1]);
  await screen.findByText(/Token saved for torbox/);
  expect(saveIntegrationToken).toHaveBeenCalledWith("torbox", "secret-token-value");
  expect((screen.getByLabelText("Token for torbox") as HTMLInputElement).value).toBe("");
  fireEvent.click(screen.getAllByRole("button", { name: "Test connection" })[0]);
  await screen.findByText(/Connected to real-debrid/);
  expect(testIntegration).toHaveBeenCalledWith("real-debrid");
  expect(document.body.innerHTML).not.toContain("secret-token-value");
});
