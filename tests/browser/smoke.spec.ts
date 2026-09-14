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
  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(
    page.getByRole("heading", { name: "Now Playing" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
