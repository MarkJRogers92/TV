import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ProviderName } from "../../src/acquisition/providerTypes.js";
import {
  ProviderError,
  type AcquisitionProvider,
  type ProviderErrorCode,
} from "../../src/integrations/acquisition/provider.js";
import type { CredentialStore } from "../../src/security/credentialStore.js";
import { buildApp } from "../../src/server/app.js";

const INTEGRATIONS_URL = "/api/v1/integrations";
const SAFE_TOP_KEYS = ["accountLabel", "connected", "error", "provider"].sort();
const FORBIDDEN_KEY_SUBSTRINGS = [
  "token",
  "authorization",
  "auth_token",
  "access_token",
  "apikey",
  "api_key",
  "api-key",
  "password",
  "secret",
  "signature",
  "cookie",
  "stack",
  "retryafter",
  "retry_after",
  "bearer",
];

function hasForbiddenKey(keys: string[]): string | null {
  for (const key of keys) {
    const normalized = key.toLowerCase();
    if (normalized === "url" || normalized.endsWith("url") || normalized.includes("_url") || normalized.includes("-url")) {
      return key;
    }
    for (const forbidden of FORBIDDEN_KEY_SUBSTRINGS) {
      if (normalized === forbidden || normalized.includes(forbidden)) {
        return key;
      }
    }
    if (normalized === "body" || normalized === "exception" || normalized === "raw") {
      return key;
    }
  }
  return null;
}

function collectJson(value: unknown, keys: string[] = [], values: string[] = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectJson(entry, keys, values);
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      keys.push(key);
      collectJson(entry, keys, values);
    }
  } else if (typeof value === "string") {
    values.push(value);
  }
  return { keys, values };
}

function expectSafeProjection(body: unknown, expectedProvider: ProviderName, token: string) {
  expect(body).toBeTypeOf("object");
  const record = body as Record<string, unknown>;
  expect(Object.keys(record).sort()).toEqual(SAFE_TOP_KEYS);
  expect(record.provider).toBe(expectedProvider);
  expect(typeof record.connected).toBe("boolean");
  if (record.accountLabel !== null) {
    expect(typeof record.accountLabel).toBe("string");
  }
  if (record.error !== null) {
    const errorRecord = record.error as Record<string, unknown>;
    expect(Object.keys(errorRecord).sort()).toEqual(["code", "message"]);
    expect(typeof errorRecord.code).toBe("string");
    expect(typeof errorRecord.message).toBe("string");
  }
  const collected = collectJson(body);
  expect(hasForbiddenKey(collected.keys)).toBeNull();
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain(token);
  for (const entry of collected.values) {
    expect(entry).not.toContain(token);
  }
}

function dumpAllTableText(directory: string): string {
  const database = new Database(join(directory, "marktv.sqlite"), { readonly: true });
  try {
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const chunks: string[] = [];
    for (const table of tables) {
      const rows = database.prepare(`SELECT * FROM "${table.name}"`).all();
      chunks.push(JSON.stringify({ table: table.name, rows }));
    }
    return chunks.join("\n");
  } finally {
    database.close();
  }
}

class InMemoryCredentialStore implements CredentialStore {
  private tokens = new Map<ProviderName, string>();
  readonly setCalls: Array<{ provider: ProviderName; token: string }> = [];

  async get(provider: ProviderName): Promise<string | null> {
    return this.tokens.get(provider) ?? null;
  }

  async set(provider: ProviderName, token: string): Promise<void> {
    this.setCalls.push({ provider, token });
    this.tokens.set(provider, token);
  }

  async remove(provider: ProviderName): Promise<void> {
    this.tokens.delete(provider);
  }
}

type MockBehavior =
  | { kind: "success"; label: string }
  | { kind: "providerError"; code: ProviderErrorCode }
  | { kind: "generic" };

const SENTINEL = "SENTINEL-RAW-PROVIDER-MESSAGE-9f3c";

class MockProvider implements AcquisitionProvider {
  readonly provider: ProviderName;
  readonly seenTokens: string[] = [];
  behavior: MockBehavior = { kind: "success", label: "mock-user" };

  constructor(provider: ProviderName) {
    this.provider = provider;
  }

  async testAuthentication(token: string) {
    this.seenTokens.push(token);
    const current = this.behavior;
    if (current.kind === "success") return { label: current.label };
    if (current.kind === "providerError") {
      throw new ProviderError(current.code, `${SENTINEL}-${current.code}`, false);
    }
    throw new Error(`${SENTINEL}-generic-failure`);
  }

  async listCompletedItems() {
    return [];
  }

  async requestDownloadUrl(): Promise<string> {
    throw new Error("not implemented");
  }
}

async function buildRig(
  directory: string,
  rig?: { store?: CredentialStore; realDebrid?: MockProvider; torbox?: MockProvider },
) {
  const store = (rig?.store ?? new InMemoryCredentialStore()) as InMemoryCredentialStore;
  const realDebrid = rig?.realDebrid ?? new MockProvider("real-debrid");
  const torbox = rig?.torbox ?? new MockProvider("torbox");
  const app = await buildApp({
    dataDir: directory,
    credentials: store,
    providers: {
      "real-debrid": realDebrid,
      torbox,
    },
  });
  return { app, store, realDebrid, torbox };
}

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "marktv-integration-routes-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("GET /api/v1/integrations", () => {
  test("returns both providers with the exact safe projection", async () => {
    const { app } = await buildRig(directory);
    try {
      const response = await app.inject({ method: "GET", url: INTEGRATIONS_URL });
      expect(response.statusCode).toBe(200);
      const body = response.json() as unknown[];
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(2);
      const providers = (body as Array<Record<string, unknown>>).map((entry) => entry.provider).sort();
      expect(providers).toEqual(["real-debrid", "torbox"]);
      for (const entry of body) {
        const record = entry as Record<string, unknown>;
        expectSafeProjection(entry, record.provider as ProviderName, "never-saved-token-abc");
        expect(record.connected).toBe(false);
        expect(record.accountLabel).toBeNull();
        expect(record.error).toBeNull();
      }
    } finally {
      await app.close();
    }
  });
});

describe("PUT /api/v1/integrations/:provider/token", () => {
  test("stores through the credential store, clears status, and never exposes the token", async () => {
    const { app, store, realDebrid } = await buildRig(directory);
    const token = "rd-test-token- alpha-789";
    try {
      const putResponse = await app.inject({
        method: "PUT",
        url: `${INTEGRATIONS_URL}/real-debrid/token`,
        payload: { token },
      });
      expect(putResponse.statusCode).toBe(200);
      expectSafeProjection(putResponse.json(), "real-debrid", token);
      expect(putResponse.json()).toMatchObject({
        provider: "real-debrid",
        connected: false,
        accountLabel: null,
        error: null,
      });
      expect(await store.get("real-debrid")).toBe(token);
      expect(store.setCalls).toEqual([{ provider: "real-debrid", token }]);
      expect(realDebrid.seenTokens).toEqual([]);

      const listed = (await app.inject({ method: "GET", url: INTEGRATIONS_URL })).json() as Array<Record<string, unknown>>;
      const entry = listed.find((item) => item.provider === "real-debrid");
      expect(entry).toMatchObject({ connected: false, accountLabel: null, error: null });
      expect(JSON.stringify(listed)).not.toContain(token);
    } finally {
      await app.close();
    }
  });

  test("masked responses are server-neutral across distinct token values", async () => {
    const first = await buildRig(directory);
    try {
      const firstPut = await first.app.inject({
        method: "PUT",
        url: `${INTEGRATIONS_URL}/torbox/token`,
        payload: { token: "first-secret-value-001" },
      });
      expect(firstPut.statusCode).toBe(200);
      const firstBody = { ...firstPut.json() } as Record<string, unknown>;
      await first.app.close();

      const secondDirectory = await mkdtemp(join(tmpdir(), "marktv-integration-neutral-"));
      try {
        const second = await buildRig(secondDirectory);
        try {
          const secondPut = await second.app.inject({
            method: "PUT",
            url: `${INTEGRATIONS_URL}/torbox/token`,
            payload: { token: "second-secret-value-002" },
          });
          expect(secondPut.statusCode).toBe(200);
          expect(secondPut.json()).toEqual(firstBody);
          expect(JSON.stringify(secondPut.json())).not.toContain("first-secret-value-001");
          expect(JSON.stringify(secondPut.json())).not.toContain("second-secret-value-002");
        } finally {
          await second.app.close();
        }
      } finally {
        await rm(secondDirectory, { recursive: true, force: true });
      }
    } finally {
      try {
        await first.app.close();
      } catch {
        // Already closed above; ignore close errors for the neutral comparison.
      }
    }
  });

  test("rejects invalid token bodies without persisting or leaking", async () => {
    const { app, store } = await buildRig(directory);
    const secret = "should-never-persist-or-echo-555";
    try {
      const invalidPayloads: unknown[] = [
        {},
        { token: "" },
        { token: "   " },
        { token: 123 },
        { token: null },
        { token: "x".repeat(5000) },
        { token: secret, extra: "rejected" },
        { unexpected: secret },
      ];
      for (const payload of invalidPayloads) {
        const response = await app.inject({
          method: "PUT",
          url: `${INTEGRATIONS_URL}/real-debrid/token`,
          payload: payload as Record<string, unknown>,
        });
        expect(response.statusCode).toBe(422);
        expect(response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
        expect(response.body).not.toContain(secret);
      }
      expect(await store.get("real-debrid")).toBeNull();
      expect(store.setCalls).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test("returns 404 for an unknown provider", async () => {
    const { app, store } = await buildRig(directory);
    try {
      const response = await app.inject({
        method: "PUT",
        url: `${INTEGRATIONS_URL}/unknown-provider/token`,
        payload: { token: "some-token" },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "NOT_FOUND" });
      expect(response.body).not.toContain("some-token");
      expect(store.setCalls).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/v1/integrations/:provider/test", () => {
  test("rejects token-bearing or malformed bodies without calling the provider", async () => {
    const { app, realDebrid } = await buildRig(directory);
    try {
      const invalidPayloads: unknown[] = [
        { token: "smuggled-token-123" },
        { token: "smuggled-token-123", extra: true },
        { unexpected: "value" },
        { token: 42 },
      ];
      for (const payload of invalidPayloads) {
        const response = await app.inject({
          method: "POST",
          url: `${INTEGRATIONS_URL}/real-debrid/test`,
          payload: payload as Record<string, unknown>,
        });
        expect(response.statusCode).toBe(422);
        expect(response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
        expect(response.body).not.toContain("smuggled-token-123");
      }
      expect(realDebrid.seenTokens).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test("returns 404 for an unknown provider", async () => {
    const { app } = await buildRig(directory);
    try {
      const response = await app.inject({ method: "POST", url: `${INTEGRATIONS_URL}/nope/test` });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "NOT_FOUND" });
    } finally {
      await app.close();
    }
  });

  test("reports NO_TOKEN without calling the provider when nothing is stored", async () => {
    const { app, realDebrid } = await buildRig(directory);
    try {
      const response = await app.inject({ method: "POST", url: `${INTEGRATIONS_URL}/real-debrid/test` });
      expect(response.statusCode).toBe(200);
      const body = response.json() as Record<string, unknown>;
      expect(body.provider).toBe("real-debrid");
      expect(body.connected).toBe(false);
      expect(body.accountLabel).toBeNull();
      const errorBody = body.error as Record<string, unknown>;
      expect(errorBody.code).toBe("NO_TOKEN");
      expect(typeof errorBody.message).toBe("string");
      expect((errorBody.message as string).length).toBeGreaterThan(0);
      expectSafeProjection(body, "real-debrid", "absent-token-marker");
      expect(realDebrid.seenTokens).toEqual([]);

      const listed = (await app.inject({ method: "GET", url: INTEGRATIONS_URL })).json() as Array<Record<string, unknown>>;
      expect(listed.find((entry) => entry.provider === "real-debrid")).toMatchObject({
        connected: false,
        accountLabel: null,
        error: { code: "NO_TOKEN" },
      });
    } finally {
      await app.close();
    }
  });

  test("reports success with the provider account label and remembers it", async () => {
    const { app, store, torbox } = await buildRig(directory);
    const token = "torbox-success-token-abc-123";
    torbox.behavior = { kind: "success", label: "torbox-user@example.com" };
    try {
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `${INTEGRATIONS_URL}/torbox/token`,
            payload: { token },
          })
        ).statusCode,
      ).toBe(200);
      const response = await app.inject({ method: "POST", url: `${INTEGRATIONS_URL}/torbox/test` });
      expect(response.statusCode).toBe(200);
      const body = response.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        provider: "torbox",
        connected: true,
        accountLabel: "torbox-user@example.com",
        error: null,
      });
      expectSafeProjection(body, "torbox", token);
      expect(await store.get("torbox")).toBe(token);
      expect(torbox.seenTokens).toEqual([token]);

      const listed = (await app.inject({ method: "GET", url: INTEGRATIONS_URL })).json() as Array<Record<string, unknown>>;
      expect(listed.find((entry) => entry.provider === "torbox")).toMatchObject({
        connected: true,
        accountLabel: "torbox-user@example.com",
        error: null,
      });
    } finally {
      await app.close();
    }
  });

  test.each([
    "AUTHENTICATION",
    "RATE_LIMITED",
    "UNAVAILABLE",
    "UNSUPPORTED_SCHEMA",
    "PERMANENT",
  ] as const)("maps %s to a fixed safe projection", async (code) => {
    const { app, realDebrid } = await buildRig(directory);
    const token = `error-token-${code}-xyz`;
    realDebrid.behavior = { kind: "providerError", code };
    try {
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `${INTEGRATIONS_URL}/real-debrid/token`,
            payload: { token },
          })
        ).statusCode,
      ).toBe(200);
      const response = await app.inject({ method: "POST", url: `${INTEGRATIONS_URL}/real-debrid/test` });
      expect(response.statusCode).toBe(200);
      const body = response.json() as Record<string, unknown>;
      expect(body.provider).toBe("real-debrid");
      expect(body.connected).toBe(false);
      expect(body.accountLabel).toBeNull();
      const errorBody = body.error as Record<string, unknown>;
      expect(errorBody.code).toBe(code);
      expect(typeof errorBody.message).toBe("string");
      expect((errorBody.message as string).length).toBeGreaterThan(0);
      expect(response.body).not.toContain(SENTINEL);
      expectSafeProjection(body, "real-debrid", token);

      const listed = (await app.inject({ method: "GET", url: INTEGRATIONS_URL })).json() as Array<Record<string, unknown>>;
      expect(listed.find((entry) => entry.provider === "real-debrid")).toMatchObject({
        connected: false,
        accountLabel: null,
        error: { code },
      });
    } finally {
      await app.close();
    }
  });

  test("redacts unknown provider failures without leaking the raw message", async () => {
    const store = new InMemoryCredentialStore();
    const realDebrid = new MockProvider("real-debrid");
    const torbox = new MockProvider("torbox");
    torbox.behavior = { kind: "generic" };
    const { app } = await buildRig(directory, { store, realDebrid, torbox });
    const token = "generic-failure-token-777";
    try {
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `${INTEGRATIONS_URL}/torbox/token`,
            payload: { token },
          })
        ).statusCode,
      ).toBe(200);
      const response = await app.inject({ method: "POST", url: `${INTEGRATIONS_URL}/torbox/test` });
      expect(response.statusCode).toBe(200);
      const body = response.json() as Record<string, unknown>;
      expect(body.provider).toBe("torbox");
      expect(body.connected).toBe(false);
      expect(body.accountLabel).toBeNull();
      const errorBody = body.error as Record<string, unknown>;
      expect(typeof errorBody.code).toBe("string");
      expect((errorBody.code as string)).not.toBe("NO_TOKEN");
      expect(typeof errorBody.message).toBe("string");
      expect(response.body).not.toContain(SENTINEL);
      expectSafeProjection(body, "torbox", token);
      expect(torbox.seenTokens).toEqual([token]);
    } finally {
      await app.close();
    }
  });

  test("saving a new token resets a prior successful status", async () => {
    const { app, torbox } = await buildRig(directory);
    torbox.behavior = { kind: "success", label: "cached-user" };
    try {
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `${INTEGRATIONS_URL}/torbox/token`,
            payload: { token: "first-token-reset-check" },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ method: "POST", url: `${INTEGRATIONS_URL}/torbox/test` })).json(),
      ).toMatchObject({ connected: true, accountLabel: "cached-user" });

      const reset = await app.inject({
        method: "PUT",
        url: `${INTEGRATIONS_URL}/torbox/token`,
        payload: { token: "second-token-reset-check" },
      });
      expect(reset.statusCode).toBe(200);
      expect(reset.json()).toMatchObject({ connected: false, accountLabel: null, error: null });
      expect(torbox.seenTokens).toEqual(["first-token-reset-check"]);

      const listed = (await app.inject({ method: "GET", url: INTEGRATIONS_URL })).json() as Array<Record<string, unknown>>;
      expect(listed.find((entry) => entry.provider === "torbox")).toMatchObject({
        connected: false,
        accountLabel: null,
        error: null,
      });
    } finally {
      await app.close();
    }
  });

  test("passes the exact stored token to the provider", async () => {
    const { app, store, realDebrid } = await buildRig(directory);
    const token = "exact-token-passthrough-!@#-AZaz09";
    try {
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `${INTEGRATIONS_URL}/real-debrid/token`,
            payload: { token },
          })
        ).statusCode,
      ).toBe(200);
      realDebrid.behavior = { kind: "success", label: "exact-user" };
      expect(
        (await app.inject({ method: "POST", url: `${INTEGRATIONS_URL}/real-debrid/test` })).statusCode,
      ).toBe(200);
      expect(await store.get("real-debrid")).toBe(token);
      expect(store.setCalls).toEqual([{ provider: "real-debrid", token }]);
      expect(realDebrid.seenTokens).toEqual([token]);
    } finally {
      await app.close();
    }
  });

  test("keeps one app status from leaking into another app", async () => {
    const firstDirectory = await mkdtemp(join(tmpdir(), "marktv-integration-first-"));
    const secondDirectory = await mkdtemp(join(tmpdir(), "marktv-integration-second-"));
    try {
      const firstStore = new InMemoryCredentialStore();
      const firstRealDebrid = new MockProvider("real-debrid");
      const firstTorbox = new MockProvider("torbox");
      firstTorbox.behavior = { kind: "success", label: "first-app-user" };
      const first = await buildRig(firstDirectory, {
        store: firstStore,
        realDebrid: firstRealDebrid,
        torbox: firstTorbox,
      });
      const secondStore = new InMemoryCredentialStore();
      const second = await buildRig(secondDirectory, {
        store: secondStore,
        realDebrid: new MockProvider("real-debrid"),
        torbox: new MockProvider("torbox"),
      });
      try {
        expect(
          (
            await first.app.inject({
              method: "PUT",
              url: `${INTEGRATIONS_URL}/torbox/token`,
              payload: { token: "first-app-token" },
            })
          ).statusCode,
        ).toBe(200);
        expect(
          (await first.app.inject({ method: "POST", url: `${INTEGRATIONS_URL}/torbox/test` })).json(),
        ).toMatchObject({ connected: true });

        const secondListed = (await second.app.inject({ method: "GET", url: INTEGRATIONS_URL })).json() as Array<Record<string, unknown>>;
        for (const entry of secondListed) {
          expect(entry).toMatchObject({ connected: false, accountLabel: null, error: null });
        }
      } finally {
        await first.app.close();
        await second.app.close();
      }
    } finally {
      await rm(firstDirectory, { recursive: true, force: true });
      await rm(secondDirectory, { recursive: true, force: true });
    }
  });

  test("leaves no token in any SQLite table after save and test", async () => {
    const { app, torbox } = await buildRig(directory);
    const firstToken = "sqlite-secret-token-001-xyz";
    const secondToken = "sqlite-secret-token-002-xyz";
    torbox.behavior = { kind: "success", label: "sqlite-user" };
    try {
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `${INTEGRATIONS_URL}/torbox/token`,
            payload: { token: firstToken },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ method: "POST", url: `${INTEGRATIONS_URL}/torbox/test` })).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `${INTEGRATIONS_URL}/real-debrid/token`,
            payload: { token: secondToken },
          })
        ).statusCode,
      ).toBe(200);
      const dump = dumpAllTableText(directory);
      expect(dump).not.toContain(firstToken);
      expect(dump).not.toContain(secondToken);
      expect(dump).not.toContain("sqlite-secret-token");
    } finally {
      await app.close();
    }
  });
});

describe("unsafe provider account labels are never trusted", () => {
  const UNSUPPORTED_MESSAGE = "Provider response is not supported.";

  async function saveAndTestLabel(directory: string, token: string, label: string) {
    const store = new InMemoryCredentialStore();
    const realDebrid = new MockProvider("real-debrid");
    const torbox = new MockProvider("torbox");
    torbox.behavior = { kind: "success", label };
    const { app } = await buildRig(directory, { store, realDebrid, torbox });
    try {
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `${INTEGRATIONS_URL}/torbox/token`,
            payload: { token },
          })
        ).statusCode,
      ).toBe(200);
      const response = await app.inject({ method: "POST", url: `${INTEGRATIONS_URL}/torbox/test` });
      return { app, response, torbox, owned: true };
    } catch (error) {
      await app.close();
      throw error;
    }
  }

  function expectFixedUnsafeProjection(body: unknown, token: string, forbidden: string[]) {
    const record = body as Record<string, unknown>;
    expect(record).toMatchObject({
      provider: "torbox",
      connected: false,
      accountLabel: null,
      error: { code: "UNSUPPORTED_SCHEMA", message: UNSUPPORTED_MESSAGE },
    });
    expectSafeProjection(body, "torbox", token);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(token);
    for (const fragment of forbidden) {
      if (fragment.length > 0) expect(serialized).not.toContain(fragment);
    }
  }

  test("rejects a label equal to the current token", async () => {
    const token = "label-safety-token-eq-001";
    const { app, response } = await saveAndTestLabel(directory, token, token);
    try {
      expect(response.statusCode).toBe(200);
      expectFixedUnsafeProjection(response.json(), token, [token]);
      const listed = (await app.inject({ method: "GET", url: INTEGRATIONS_URL })).json() as Array<
        Record<string, unknown>
      >;
      const entry = listed.find((item) => item.provider === "torbox");
      expect(entry).toMatchObject({
        connected: false,
        accountLabel: null,
        error: { code: "UNSUPPORTED_SCHEMA" },
      });
      expect(JSON.stringify(listed)).not.toContain(token);
    } finally {
      await app.close();
    }
  });

  test("rejects a label containing the current token", async () => {
    const token = "label-safety-token-in-002";
    const label = `user-${token}-suffix`;
    const { app, response } = await saveAndTestLabel(directory, token, label);
    try {
      expect(response.statusCode).toBe(200);
      expectFixedUnsafeProjection(response.json(), token, [token, label]);
      const listed = (await app.inject({ method: "GET", url: INTEGRATIONS_URL })).json() as Array<
        Record<string, unknown>
      >;
      expect(listed.find((item) => item.provider === "torbox")).toMatchObject({
        connected: false,
        accountLabel: null,
        error: { code: "UNSUPPORTED_SCHEMA" },
      });
      expect(JSON.stringify(listed)).not.toContain(token);
    } finally {
      await app.close();
    }
  });

  test("rejects a credential-bearing URL label", async () => {
    const token = "label-safety-token-url-003";
    const secret = "url-secret-abc-003";
    const label = `https://user:${secret}@downloads.example.com/file?access_token=${secret}`;
    const { app, response } = await saveAndTestLabel(directory, token, label);
    try {
      expect(response.statusCode).toBe(200);
      expectFixedUnsafeProjection(response.json(), token, [secret, "access_token", "https://"]);
      expect(response.body).not.toContain("https://");
      const listed = (await app.inject({ method: "GET", url: INTEGRATIONS_URL })).json() as Array<
        Record<string, unknown>
      >;
      expect(listed.find((item) => item.provider === "torbox")).toMatchObject({
        connected: false,
        accountLabel: null,
        error: { code: "UNSUPPORTED_SCHEMA" },
      });
      expect(JSON.stringify(listed)).not.toContain(secret);
      expect(JSON.stringify(listed)).not.toContain(token);
    } finally {
      await app.close();
    }
  });

  test("rejects a bearer-material label", async () => {
    const token = "label-safety-token-bearer-004";
    const label = "Bearer abc123def456";
    const { app, response } = await saveAndTestLabel(directory, token, label);
    try {
      expect(response.statusCode).toBe(200);
      expectFixedUnsafeProjection(response.json(), token, ["Bearer", "abc123def456"]);
      const listed = (await app.inject({ method: "GET", url: INTEGRATIONS_URL })).json() as Array<
        Record<string, unknown>
      >;
      expect(listed.find((item) => item.provider === "torbox")).toMatchObject({
        connected: false,
        accountLabel: null,
        error: { code: "UNSUPPORTED_SCHEMA" },
      });
      expect(JSON.stringify(listed)).not.toContain("abc123def456");
    } finally {
      await app.close();
    }
  });

  test("rejects a label with control characters", async () => {
    const token = "label-safety-token-ctrl-005";
    const label = "good-user\u0000bad";
    const { app, response } = await saveAndTestLabel(directory, token, label);
    try {
      expect(response.statusCode).toBe(200);
      expectFixedUnsafeProjection(response.json(), token, ["good-user"]);
      const listed = (await app.inject({ method: "GET", url: INTEGRATIONS_URL })).json() as Array<
        Record<string, unknown>
      >;
      expect(listed.find((item) => item.provider === "torbox")).toMatchObject({
        connected: false,
        accountLabel: null,
        error: { code: "UNSUPPORTED_SCHEMA" },
      });
      expect(JSON.stringify(listed)).not.toContain(token);
    } finally {
      await app.close();
    }
  });

  test("rejects an overlong label", async () => {
    const token = "label-safety-token-long-006";
    const label = "x".repeat(200);
    const { app, response } = await saveAndTestLabel(directory, token, label);
    try {
      expect(response.statusCode).toBe(200);
      expectFixedUnsafeProjection(response.json(), token, []);
      const listed = (await app.inject({ method: "GET", url: INTEGRATIONS_URL })).json() as Array<
        Record<string, unknown>
      >;
      expect(listed.find((item) => item.provider === "torbox")).toMatchObject({
        connected: false,
        accountLabel: null,
        error: { code: "UNSUPPORTED_SCHEMA" },
      });
      expect(JSON.stringify(listed)).not.toContain(token);
    } finally {
      await app.close();
    }
  });
});

describe("credential store save failures are contained", () => {
  const SAVE_SENTINEL = "SAVE-SENTINEL-9f3c-failure";
  const EXPECTED_SAVE_MESSAGE = "Provider test failed. Try again later.";

  class FlakyCredentialStore implements CredentialStore {
    private tokens = new Map<ProviderName, string>();
    readonly setCalls: Array<{ provider: ProviderName; token: string }> = [];
    failNextSet: Error | null = null;

    async get(provider: ProviderName): Promise<string | null> {
      return this.tokens.get(provider) ?? null;
    }

    async set(provider: ProviderName, token: string): Promise<void> {
      if (this.failNextSet) {
        const failure = this.failNextSet;
        this.failNextSet = null;
        throw failure;
      }
      this.setCalls.push({ provider, token });
      this.tokens.set(provider, token);
    }

    async remove(provider: ProviderName): Promise<void> {
      this.tokens.delete(provider);
    }
  }

  test("save failure returns deliberate 503 safe projection and preserves prior status", async () => {
    const store = new FlakyCredentialStore();
    const realDebrid = new MockProvider("real-debrid");
    const torbox = new MockProvider("torbox");
    torbox.behavior = { kind: "success", label: "stable-user" };
    const { app } = await buildRig(directory, { store, realDebrid, torbox });
    const firstToken = "stable-prior-token-001";
    const secondToken = "failing-save-token-002";
    try {
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `${INTEGRATIONS_URL}/torbox/token`,
            payload: { token: firstToken },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ method: "POST", url: `${INTEGRATIONS_URL}/torbox/test` })).json(),
      ).toMatchObject({ connected: true, accountLabel: "stable-user" });

      store.failNextSet = new Error(
        `disk full saving ${secondToken} at https://vault.example.invalid/write?token=${secondToken} ${SAVE_SENTINEL} stack-trace-marker`,
      );
      const failed = await app.inject({
        method: "PUT",
        url: `${INTEGRATIONS_URL}/torbox/token`,
        payload: { token: secondToken },
      });
      expect(failed.statusCode).toBe(503);
      const body = failed.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        provider: "torbox",
        connected: false,
        accountLabel: null,
        error: { code: "PROVIDER_ERROR", message: EXPECTED_SAVE_MESSAGE },
      });
      expectSafeProjection(body, "torbox", secondToken);
      expect(failed.body).not.toContain(secondToken);
      expect(failed.body).not.toContain(SAVE_SENTINEL);
      expect(failed.body).not.toContain("https://vault.example.invalid");
      expect(failed.body).not.toContain("stack-trace-marker");

      const listed = (await app.inject({ method: "GET", url: INTEGRATIONS_URL })).json() as Array<
        Record<string, unknown>
      >;
      expect(listed.find((entry) => entry.provider === "torbox")).toMatchObject({
        connected: true,
        accountLabel: "stable-user",
        error: null,
      });
      expect(JSON.stringify(listed)).not.toContain(secondToken);
      expect(await store.get("torbox")).toBe(firstToken);
      expect(torbox.seenTokens).toEqual([firstToken]);
    } finally {
      await app.close();
    }
  });

  test("save failure without prior status stays disconnected and safe", async () => {
    const store = new FlakyCredentialStore();
    const failingToken = "failing-first-save-token-003";
    store.failNextSet = new Error(
      `boom ${failingToken} https://vault.example.invalid/x?api_key=${failingToken} ${SAVE_SENTINEL}`,
    );
    const { app } = await buildRig(directory, {
      store,
      realDebrid: new MockProvider("real-debrid"),
      torbox: new MockProvider("torbox"),
    });
    try {
      const failed = await app.inject({
        method: "PUT",
        url: `${INTEGRATIONS_URL}/real-debrid/token`,
        payload: { token: failingToken },
      });
      expect(failed.statusCode).toBe(503);
      expect(failed.body).not.toContain(failingToken);
      expect(failed.body).not.toContain(SAVE_SENTINEL);
      const listed = (await app.inject({ method: "GET", url: INTEGRATIONS_URL })).json() as Array<
        Record<string, unknown>
      >;
      expect(listed.find((entry) => entry.provider === "real-debrid")).toMatchObject({
        connected: false,
        accountLabel: null,
        error: null,
      });
    } finally {
      await app.close();
    }
  });
});

describe("provider map validation", () => {
  test("rejects a missing provider", async () => {
    const realDebrid = new MockProvider("real-debrid");
    await expect(
      buildApp({
        dataDir: directory,
        credentials: new InMemoryCredentialStore(),
        providers: { "real-debrid": realDebrid } as unknown as Record<ProviderName, AcquisitionProvider>,
      }),
    ).rejects.toThrow(/provider map/i);
    expect(realDebrid.seenTokens).toEqual([]);
  });

  test("rejects swapped implementations", async () => {
    const realDebrid = new MockProvider("real-debrid");
    const torbox = new MockProvider("torbox");
    await expect(
      buildApp({
        dataDir: directory,
        credentials: new InMemoryCredentialStore(),
        providers: { "real-debrid": torbox, torbox: realDebrid },
      }),
    ).rejects.toThrow(/provider map/i);
    expect(realDebrid.seenTokens).toEqual([]);
    expect(torbox.seenTokens).toEqual([]);
  });

  test("rejects a mismatched implementation identity", async () => {
    const realDebrid = new MockProvider("real-debrid");
    const impostor = new MockProvider("real-debrid");
    await expect(
      buildApp({
        dataDir: directory,
        credentials: new InMemoryCredentialStore(),
        providers: { "real-debrid": realDebrid, torbox: impostor },
      }),
    ).rejects.toThrow(/provider map/i);
    expect(realDebrid.seenTokens).toEqual([]);
    expect(impostor.seenTokens).toEqual([]);
  });

  test("routes each token only to its own provider", async () => {
    const { app, realDebrid, torbox } = await buildRig(directory);
    const realToken = "route-real-debrid-token-001";
    const torboxToken = "route-torbox-token-002";
    try {
      realDebrid.behavior = { kind: "success", label: "rd-user" };
      torbox.behavior = { kind: "success", label: "tb-user" };
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `${INTEGRATIONS_URL}/real-debrid/token`,
            payload: { token: realToken },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `${INTEGRATIONS_URL}/torbox/token`,
            payload: { token: torboxToken },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ method: "POST", url: `${INTEGRATIONS_URL}/real-debrid/test` })).statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ method: "POST", url: `${INTEGRATIONS_URL}/torbox/test` })).statusCode,
      ).toBe(200);
      expect(realDebrid.seenTokens).toEqual([realToken]);
      expect(torbox.seenTokens).toEqual([torboxToken]);
      expect(realDebrid.seenTokens).not.toContain(torboxToken);
      expect(torbox.seenTokens).not.toContain(realToken);
    } finally {
      await app.close();
    }
  });
});
