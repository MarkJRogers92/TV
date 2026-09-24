import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { buildApp } from "../../src/server/app.js";
import type { PreparationIntakeRunner } from "../../src/preparation/intakeRunner.js";

function dataDir() {
  return mkdtemp(`${tmpdir()}/marktv-intake-app-`);
}

function fakeRunner() {
  const runner = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    runOnce: vi.fn(async () => undefined),
  } satisfies PreparationIntakeRunner;
  return runner;
}

test("starts the intake runner only when opted in, and stops it on close", async () => {
  const runners: PreparationIntakeRunner[] = [];
  const app = await buildApp({
    dataDir: await dataDir(),
    preparationIntake: true,
    createIntakeRunner: () => {
      const runner = fakeRunner();
      runners.push(runner);
      return runner;
    },
  });

  expect(runners).toHaveLength(1);
  expect(runners[0].start).toHaveBeenCalledTimes(1);
  await app.close();
  expect(runners[0].stop).toHaveBeenCalledTimes(1);
});

test("does not create the intake runner by default", async () => {
  const createIntakeRunner = vi.fn();
  const app = await buildApp({ dataDir: await dataDir(), createIntakeRunner });
  expect(createIntakeRunner).not.toHaveBeenCalled();
  await app.close();
});

test("the real intake runner starts and shuts down cleanly through the lifecycle", async () => {
  const app = await buildApp({ dataDir: await dataDir(), preparationIntake: true });
  await app.close();
});
