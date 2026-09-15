import { expect, test } from "@playwright/test";

test("runs the seeded admin workflow without browser errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "MarkTV" })).toBeVisible();
  await expect(page.getByText("MarkTV Laughs · Channel 7")).toBeVisible();
  await expect(page.getByText("Preview only")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Now Playing" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Up Next" })).toBeVisible();

  await page.getByRole("link", { name: "Schedule" }).click();
  await expect(page.getByRole("heading", { name: "Schedule" })).toBeVisible();
  await page.getByRole("button", { name: "Generate schedule" }).click();
  await expect(
    page.getByRole("table", { name: "Electronic program guide" }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "Apartment 4B 1" }).first(),
  ).toBeVisible();

  for (const name of ["Channel", "Library", "Tunarr"] as const) {
    await page.getByRole("link", { name }).click();
    await expect(page.getByRole("heading", { name })).toBeVisible();
  }

  await page.getByRole("link", { name: "Wanted" }).click();
  await expect(
    page.getByRole("heading", { name: "Wanted", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Track episodes MarkTV should acquire."),
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Add a wanted episode" }),
  ).toBeVisible();
  await expect(page.getByLabel("Series title")).toBeVisible();
  await expect(page.getByLabel("Season")).toBeVisible();
  await expect(page.getByLabel("Episode", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Episode title (optional)")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add episode" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /Wanted episodes/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /Season packs/ }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Integrations" }).click();
  await expect(
    page.getByRole("heading", { name: "Integrations", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Tokens are never shown again."),
  ).toBeVisible();
  for (const label of ["Real-Debrid", "TorBox"] as const) {
    await expect(
      page.getByRole("heading", { name: label }),
    ).toBeVisible();
  }
  const realDebridToken = page.getByLabel("Token for real-debrid");
  const torBoxToken = page.getByLabel("Token for torbox");
  await expect(realDebridToken).toBeVisible();
  await expect(torBoxToken).toBeVisible();
  await expect(realDebridToken).toHaveValue("");
  await expect(torBoxToken).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Save token" }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Test connection" }).first(),
  ).toBeVisible();

  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(
    page.getByRole("heading", { name: "Now Playing" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
