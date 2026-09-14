import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ChannelEditor } from "../../web/pages/ChannelEditor";
import { demo } from "../../src/demo/marktvLaughs.js";

afterEach(cleanup);

test("edits channel identity, timezone, dayparts, slots, selection, and break settings", async () => {
  const seeded = demo().channel;
  const client = {
    getChannel: vi.fn(async () => seeded),
    listPools: vi.fn(async () => demo().pools),
    updateChannel: vi.fn(async (channel) => channel),
    updatePool: vi.fn(async (pool) => pool),
  };
  render(<ChannelEditor client={client as never} channelId="marktv-laughs" />);
  const name = await screen.findByLabelText("Channel name");
  fireEvent.change(name, { target: { value: "Edited Laughs" } });
  fireEvent.change(screen.getByLabelText("Timezone"), {
    target: { value: "America/Denver" },
  });
  fireEvent.change(screen.getByLabelText("Daypart start"), {
    target: { value: "06:00" },
  });
  fireEvent.change(screen.getByLabelText("Selection mode"), {
    target: { value: "shuffle" },
  });
  fireEvent.change(screen.getByLabelText("No-repeat minutes"), {
    target: { value: "90" },
  });
  fireEvent.change(screen.getByLabelText("Break boundary minutes"), {
    target: { value: "15" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save channel" }));

  await waitFor(() => expect(client.updateChannel).toHaveBeenCalled());
  const saved = client.updateChannel.mock.calls[0][0];
  expect(saved).toMatchObject({
    name: "Edited Laughs",
    timezone: "America/Denver",
    dayparts: expect.arrayContaining([
      expect.objectContaining({ id: "morning", start: "06:00" }),
    ]),
    breakPolicy: { boundaryMinutes: 15 },
  });
  expect(screen.getByText("Channel saved.")).toBeVisible();
});

test("keeps entered values and renders inline API validation issues", async () => {
  const seeded = demo().channel;
  const client = {
    getChannel: async () => seeded,
    listPools: async () => demo().pools,
    updateChannel: vi.fn(async () => {
      throw { issues: [{ path: "dayparts", message: "Dayparts overlap" }] };
    }),
    updatePool: vi.fn(),
  };
  render(<ChannelEditor client={client as never} channelId="marktv-laughs" />);
  const name = await screen.findByLabelText("Channel name");
  fireEvent.change(name, { target: { value: "Still Here" } });
  fireEvent.click(screen.getByRole("button", { name: "Save channel" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "dayparts: Dayparts overlap",
  );
  expect(name).toHaveValue("Still Here");
});

test("persists multiple primary and fallback pools plus each pool's selection settings", async () => {
  const seeded = demo();
  const client = {
    getChannel: vi.fn(async () => seeded.channel),
    listPools: vi.fn(async () => seeded.pools),
    updateChannel: vi.fn(async (channel) => channel),
    updatePool: vi.fn(async (pool) => pool),
  };
  render(<ChannelEditor client={client as never} channelId="marktv-laughs" />);
  await screen.findByLabelText("Channel name");
  fireEvent.change(screen.getByLabelText("Slot 2 pool IDs"), {
    target: { value: "space-neighbors,apartment-4b" },
  });
  fireEvent.change(screen.getByLabelText("Slot 2 fallback pool IDs"), {
    target: { value: "movies" },
  });
  fireEvent.change(screen.getByLabelText("Weight for Space Neighbors"), {
    target: { value: "4" },
  });
  fireEvent.change(screen.getByLabelText("Selection mode for Apartment 4B"), {
    target: { value: "shuffle" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save channel" }));

  await waitFor(() => expect(client.updateChannel).toHaveBeenCalled());
  expect(client.updateChannel.mock.calls[0][0].slots[1]).toMatchObject({
    poolIds: ["space-neighbors", "apartment-4b"],
    fallbackPoolIds: ["movies"],
  });
  await waitFor(() =>
    expect(client.updatePool).toHaveBeenCalledWith(
      expect.objectContaining({ id: "space-neighbors", weight: 4 }),
    ),
  );
  expect(client.updatePool).toHaveBeenCalledWith(
    expect.objectContaining({ id: "apartment-4b", mode: "shuffle" }),
  );
});
