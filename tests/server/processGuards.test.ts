import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import { logSink } from "../../src/server/logging.js";
import { installProcessGuards } from "../../src/server/processGuards.js";

const previous = logSink.sink;
afterEach(() => {
  logSink.sink = previous;
});

/** A stand-in for `process`, so the guards can be exercised without exiting. */
function fakeProcess() {
  const emitter = new EventEmitter();
  const exit = vi.fn();
  return {
    target: { on: emitter.on.bind(emitter), exit },
    emit: emitter.emit.bind(emitter),
    exit,
  };
}

test("records an unhandled rejection and keeps running", () => {
  const lines: string[] = [];
  logSink.sink = (line) => lines.push(line);
  const fake = fakeProcess();
  installProcessGuards(fake.target);

  fake.emit("unhandledRejection", new Error("boom"));

  expect(lines.join("\n")).toContain("process.unhandledRejection");
  expect(lines.join("\n")).toContain("boom");
  // Staying up is deliberate: one rejected promise is a bug in one path, not
  // evidence that the whole process is unsound.
  expect(fake.exit).not.toHaveBeenCalled();
});

test("records an uncaught exception and exits non-zero", () => {
  const lines: string[] = [];
  logSink.sink = (line) => lines.push(line);
  const fake = fakeProcess();
  installProcessGuards(fake.target);

  fake.emit("uncaughtException", new Error("fatal"));

  expect(lines.join("\n")).toContain("process.uncaughtException");
  expect(lines.join("\n")).toContain("fatal");
  // Exiting is deliberate: after this the runtime state is not trustworthy, and
  // launchd restarts the service from known state within ~10s.
  expect(fake.exit).toHaveBeenCalledWith(1);
});
