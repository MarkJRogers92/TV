import { afterEach, expect, test } from "vitest";
import { errorLog, logError } from "../../src/server/logging.js";

const previous = errorLog.sink;
afterEach(() => {
  errorLog.sink = previous;
});

test("emits one structured line carrying the scope, message and context", () => {
  const lines: string[] = [];
  errorLog.sink = (line) => lines.push(line);

  logError("acquisition.poll", new Error("boom"), { attempt: 2 });

  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({
    level: "error",
    scope: "acquisition.poll",
    message: "Error: boom",
    attempt: 2,
  });
});

test("describes a non-Error throwable without losing it", () => {
  const lines: string[] = [];
  errorLog.sink = (line) => lines.push(line);

  logError("acquisition.jobs", "provider returned nonsense");

  expect(JSON.parse(lines[0]!).message).toBe("provider returned nonsense");
});

test("never throws, even when the sink is broken or the context cannot serialise", () => {
  // This runs inside catch blocks that are already reporting a failure, so a throw
  // here would replace the real error with a logging error - in the one place
  // where that is least recoverable.
  errorLog.sink = () => {
    throw new Error("sink is broken");
  };
  expect(() => logError("scope", new Error("boom"))).not.toThrow();

  const lines: string[] = [];
  errorLog.sink = (line) => lines.push(line);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expect(() => logError("scope", new Error("boom"), { circular })).not.toThrow();
  expect(lines).toHaveLength(0);
});
