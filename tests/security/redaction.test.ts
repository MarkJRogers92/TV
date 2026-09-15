import { describe, expect, it } from "vitest";
import { redactSensitive } from "../../src/security/redaction.js";

describe("redactSensitive", () => {
  it("redacts bearer credentials and credential-bearing URLs without changing safe text", () => {
    const safe = "Provider temporarily unavailable";
    expect(redactSensitive(safe)).toBe(safe);
    expect(redactSensitive("Authorization: Bearer very-secret-token")).not.toContain("very-secret-token");
    expect(redactSensitive("https://cdn.example/video?token=abc&quality=720p")).not.toContain("cdn.example/video");
    expect(redactSensitive("https://cdn.example/video?token=abc&quality=720p")).toContain("[REDACTED_URL]");
  });

  it("redacts bare or relative credential parameters and capability URL fields", () => {
    expect(redactSensitive("provider returned token=bare-secret while retrying")).not.toContain("bare-secret");
    expect(redactSensitive("/requestdl?token=relative-secret&file_id=12")).toBe("[REDACTED_URL]");
    expect(redactSensitive("safe=value")).toBe("safe=value");

    const source = {
      download: "https://cdn.example/movie.mp4",
      downloadUrl: "/requestdl?file=12",
      signedUrl: "https://cdn.example/file?quality=720p",
      capabilityUrl: "https://cdn.example/another-file",
    };
    const result = redactSensitive(source) as Record<string, string>;

    expect(Object.values(result)).toEqual(["[REDACTED_URL]", "[REDACTED_URL]", "[REDACTED_URL]", "[REDACTED_URL]"]);
    expect(source.download).toBe("https://cdn.example/movie.mp4");
  });

  it("redacts sensitive query/header shapes and nested error causes without mutation", () => {
    const source = {
      token: "token-value",
      nested: {
        auth_token: "other-token",
        headers: { Authorization: "Bearer bearer-value", "x-api-key": "key-value", Accept: "application/json" },
      },
      error: new Error("request failed https://host.test/file?api_key=secret"),
    };
    (source.error as Error & { cause?: unknown }).cause = { url: "https://host.test/file?signature=signed-secret" };

    const result = redactSensitive(source);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("token-value");
    expect(serialized).not.toContain("other-token");
    expect(serialized).not.toContain("bearer-value");
    expect(serialized).not.toContain("key-value");
    expect(serialized).not.toContain("signed-secret");
    expect((result as { nested: { headers: { Accept: string } } }).nested.headers.Accept).toBe("application/json");
    expect(source.token).toBe("token-value");
    expect(source.nested.auth_token).toBe("other-token");
  });

  it("handles cycles and Error causes safely", () => {
    const cyclic: { self?: unknown; message: string; authorization: string } = {
      message: "safe message",
      authorization: "Bearer no-show",
    };
    cyclic.self = cyclic;

    const result = redactSensitive(cyclic) as { self: unknown; authorization: string; message: string };
    expect(result).not.toBe(cyclic);
    expect(result.self).toBe(result);
    expect(result.authorization).toBe("[REDACTED]");
    expect(result.message).toBe("safe message");
  });
});
