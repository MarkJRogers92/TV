import { describe, expect, it } from "vitest";
import {
  KeychainCredentialStore,
  runSecurityCommand,
  type SecurityCommandRunner,
} from "../../src/security/keychain.js";

describe("KeychainCredentialStore", () => {
  it("writes a token through stdin, never through command arguments", async () => {
    const calls: Array<{ executable: string; args: readonly string[]; stdin?: string }> = [];
    const runner: SecurityCommandRunner = async (command) => {
      calls.push(command);
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const store = new KeychainCredentialStore(runner);
    const token = "super-secret-token";

    await store.set("real-debrid", token);

    expect(calls).toEqual([
      expect.objectContaining({
        executable: "/usr/bin/swift",
        stdin: token,
      }),
    ]);
    expect(calls[0]?.args.slice(-3)).toEqual([
      "set",
      "real-debrid",
      "MarkTV Acquisition",
    ]);
    expect(JSON.stringify(calls[0]?.args)).not.toContain(token);
    expect(calls[0]?.executable).not.toContain(token);
  });

  it("forwards exact private stdin bytes to the native helper", async () => {
    const result = await runSecurityCommand({
      executable: "/bin/sh",
      args: ["-c", "value=$(cat); [ \"$value\" = prompt-value ]"],
      stdin: "prompt-value",
    });
    expect(result.exitCode).toBe(0);
  });

  it("reads and removes a credential without exposing command diagnostics", async () => {
    const calls: Array<{ executable: string; args: readonly string[]; stdin?: string }> = [];
    const runner: SecurityCommandRunner = async (command) => {
      calls.push(command);
      if (command.args.at(-3) === "get") {
        return { stdout: "stored-token\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const store = new KeychainCredentialStore(runner);

    await expect(store.get("torbox")).resolves.toBe("stored-token");
    await store.remove("torbox");

    expect(calls[0]?.args.slice(-3)).toEqual([
      "get",
      "torbox",
      "MarkTV Acquisition",
    ]);
    expect(calls[1]).toEqual(
      expect.objectContaining({
        executable: "/usr/bin/security",
        args: [
          "delete-generic-password",
          "-a",
          "torbox",
          "-s",
          "MarkTV Acquisition",
        ],
      }),
    );
  });

  it("validates provider and nonempty tokens without passing a secret to a runner", async () => {
    let calls = 0;
    const runner: SecurityCommandRunner = async () => {
      calls += 1;
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const store = new KeychainCredentialStore(runner);

    await expect(store.set("unknown" as "real-debrid", "token")).rejects.toThrow("provider");
    await expect(store.set("torbox", "   ")).rejects.toThrow("token");
    await expect(store.set("torbox", "first\nsecond")).rejects.toThrow("token");
    expect(calls).toBe(0);
  });

  it("does not put sensitive command output or errors in thrown errors", async () => {
    const secret = "leaked-in-diagnostics";
    const runner: SecurityCommandRunner = async () => ({
      stdout: secret,
      stderr: secret,
      exitCode: 1,
    });
    const store = new KeychainCredentialStore(runner);

    await expect(store.set("torbox", "safe-token")).rejects.not.toThrow(secret);
    await expect(store.set("torbox", "safe-token")).rejects.toThrow("Keychain command failed");
  });
});
