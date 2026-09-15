// @vitest-environment node

import { readdir, readFile } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  assertLoopbackHost,
  isLoopbackAuthority,
  isLoopbackBrowserUrl,
} from "../../src/server/app.js";

test.each(["127.0.0.1", "127.0.0.2", "::1", "localhost", "LOCALHOST"])(
  "accepts the loopback host %s",
  (host) => {
    expect(() => assertLoopbackHost(host)).not.toThrow();
  },
);

test.each([
  "0.0.0.0",
  "::",
  "192.168.1.10",
  "10.0.0.5",
  "172.16.0.1",
  "8.8.8.8",
  "marktv.example.com",
  "",
])("rejects the non-loopback host %s before listen", (host) => {
  expect(() => assertLoopbackHost(host)).toThrow(/loopback/i);
});

test.each(["localhost", "localhost:3100", "127.0.0.1", "127.9.8.7:3100", "[::1]", "[::1]:3100"])(
  "accepts only exact loopback Host authorities: %s",
  (host) => expect(isLoopbackAuthority(host)).toBe(true),
);

test.each(["localhost.evil.test", "127.0.0.1.evil.test", "[::1].evil.test", "evil.test", "127.0.0.1:bad", "127.0.0.1@evil.test"])(
  "rejects hostile or DNS-rebinding Host authority: %s",
  (host) => expect(isLoopbackAuthority(host)).toBe(false),
);

test.each(["http://localhost:3100", "http://127.0.0.1:3100/path", "http://[::1]:3100/path"])(
  "accepts local browser URL: %s",
  (value) => expect(isLoopbackBrowserUrl(value)).toBe(true),
);

test.each(["https://marktv.example.test", "http://localhost.evil.test", "null", "file:///tmp/marktv", "http://user@localhost"])(
  "rejects hostile Origin/Referer value: %s",
  (value) => expect(isLoopbackBrowserUrl(value)).toBe(false),
);

test("guards the only shipped listen call in the server entrypoint", async () => {
  const source = await readFile(
    new URL("../../src/server/index.ts", import.meta.url),
    "utf8",
  );
  const guard = source.indexOf("assertLoopbackHost(host)");
  const listen = source.indexOf("app.listen({ host, port })");
  expect(guard).toBeGreaterThanOrEqual(0);
  expect(listen).toBeGreaterThan(guard);
  // Evidence for the "no concrete bypass" ruling: the guard receives the same
  // `host` binding that is handed to Fastify, and no other shipped source file
  // opens a listener, so there is no alternate bind path to guard.
  expect(await shippedListeners()).toEqual(["src/server/index.ts"]);
});

async function shippedListeners(): Promise<string[]> {
  const root = fileURLToPath(new URL("../../src", import.meta.url));
  const found: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".ts")) {
        const text = await readFile(path, "utf8");
        if (/\.listen\s*\(/.test(text)) found.push(relative(process.cwd(), path));
      }
    }
  };
  await walk(root);
  return found.sort();
}
