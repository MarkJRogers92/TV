import { spawn } from "node:child_process";
import type { ProviderName } from "../acquisition/providerTypes.js";
import type { CredentialStore } from "./credentialStore.js";

const SECURITY_EXECUTABLE = "/usr/bin/swift";
const SECURITY_CLI = "/usr/bin/security";
const SERVICE_NAME = "MarkTV Acquisition";
const KNOWN_PROVIDERS = new Set<ProviderName>(["real-debrid", "torbox"]);
const ITEM_NOT_FOUND_EXIT_CODE = 44;
const KEYCHAIN_COMMAND_TIMEOUT_MS = 30_000;
const KEYCHAIN_HELPER = String.raw`
import Foundation
import Security

guard CommandLine.arguments.count == 4 else { exit(64) }
let operation = CommandLine.arguments[1]
let account = CommandLine.arguments[2]
let service = CommandLine.arguments[3]
let base: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrAccount as String: account,
  kSecAttrService as String: service,
]

switch operation {
case "get":
  var query = base
  query[kSecReturnData as String] = true
  query[kSecMatchLimit as String] = kSecMatchLimitOne
  var result: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &result)
  if status == errSecItemNotFound { exit(44) }
  guard status == errSecSuccess, let data = result as? Data else { exit(1) }
  FileHandle.standardOutput.write(data)
case "set":
  let data = FileHandle.standardInput.readDataToEndOfFile()
  guard !data.isEmpty else { exit(64) }
  let attributes = [kSecValueData as String: data]
  let updated = SecItemUpdate(base as CFDictionary, attributes as CFDictionary)
  if updated == errSecItemNotFound {
    var addition = base
    addition[kSecValueData as String] = data
    guard SecItemAdd(addition as CFDictionary, nil) == errSecSuccess else { exit(1) }
  } else if updated != errSecSuccess {
    exit(1)
  }
case "remove":
  let status = SecItemDelete(base as CFDictionary)
  if status == errSecItemNotFound { exit(44) }
  guard status == errSecSuccess else { exit(1) }
default:
  exit(64)
}
`;

export interface SecurityCommand {
  readonly executable: string;
  readonly args: readonly string[];
  /** Secret input is written directly to the child process standard input. */
  readonly stdin?: string;
}

export interface SecurityCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type SecurityCommandRunner = (command: SecurityCommand) => Promise<SecurityCommandResult>;

function assertProvider(provider: ProviderName): void {
  if (!KNOWN_PROVIDERS.has(provider)) {
    throw new Error("Invalid credential provider");
  }
}

function assertToken(token: string): void {
  if (
    typeof token !== "string" ||
    token.trim().length === 0 ||
    /[\r\n]/.test(token)
  ) {
    throw new Error("Credential token must be nonempty");
  }
}

function commandFailure(): Error {
  // Do not include child output, stderr, arguments, or the input token here.
  return new Error("Keychain command failed");
}

export const runSecurityCommand: SecurityCommandRunner = async ({ executable, args, stdin }) =>
  new Promise<SecurityCommandResult>((resolve, reject) => {
    // The native helper reads credential bytes only from this private stdin
    // pipe. Its command arguments contain source, operation, account, and
    // service, but never the token.
    const child = spawn(executable, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(commandFailure());
    }, KEYCHAIN_COMMAND_TIMEOUT_MS);
    timer.unref?.();
    const finish = (result: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      result();
    };

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", () => finish(() => reject(commandFailure())));
    child.once("close", (exitCode) => {
      finish(() =>
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exitCode: exitCode ?? 1,
        }),
      );
    });

    // `security add-generic-password ... -w` (with -w last and no value)
    // prompts for the value; piping it avoids ever putting an access token in
    // an argv entry.
    child.stdin.end(stdin);
  });

export class KeychainCredentialStore implements CredentialStore {
  constructor(
    private readonly runner: SecurityCommandRunner = runSecurityCommand,
    private readonly serviceName = SERVICE_NAME,
  ) {}

  async get(provider: ProviderName): Promise<string | null> {
    assertProvider(provider);
    const result = await this.runner({
      executable: SECURITY_EXECUTABLE,
      args: ["-e", KEYCHAIN_HELPER, "get", provider, this.serviceName],
    });
    if (result.exitCode === ITEM_NOT_FOUND_EXIT_CODE) return null;
    if (result.exitCode !== 0) throw commandFailure();
    const token = result.stdout.trim();
    return token.length > 0 ? token : null;
  }

  async set(provider: ProviderName, token: string): Promise<void> {
    assertProvider(provider);
    assertToken(token);
    const result = await this.runner({
      executable: SECURITY_EXECUTABLE,
      args: ["-e", KEYCHAIN_HELPER, "set", provider, this.serviceName],
      stdin: token,
    });
    if (result.exitCode !== 0) throw commandFailure();
  }

  async remove(provider: ProviderName): Promise<void> {
    assertProvider(provider);
    const result = await this.runner({
      executable: SECURITY_CLI,
      args: ["delete-generic-password", "-a", provider, "-s", this.serviceName],
    });
    if (result.exitCode !== 0 && result.exitCode !== ITEM_NOT_FOUND_EXIT_CODE) {
      throw commandFailure();
    }
  }
}
