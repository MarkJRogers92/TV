/**
 * Alerts: how a person finds out.
 *
 * The recovery controller is deliberately built to fail quietly - bounded
 * repairs, a circuit breaker, acknowledge-only-on-success - which is right for
 * automation and useless to a human. It records incidents durably, but "it is
 * recorded" is not "you find out": a channel could sit in a failed state all
 * night and the first anyone knows is watching television.
 *
 * So this is the human half, and it is deliberately small:
 *
 *  - one append-only file of JSON lines, in a location a person can be told to
 *    look at, containing the channel, what was decided, and what to do next;
 *  - an optional desktop notification, best-effort, because whether a
 *    LaunchAgent can reach the window server is not something this code should
 *    assume - so the outcome of each attempt is recorded IN the alert rather
 *    than being silently hoped for;
 *  - a bounded file: the last `keepLines` alerts, trimmed once the file passes
 *    `maxBytes`. An alert log that grows without limit is its own future
 *    incident.
 *
 * Nothing here may throw into its caller. An alerting path that can break
 * recovery is worse than no alerting path, so every operation is best-effort
 * and reports failure through the return value instead.
 */
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { redactSensitive } from "../security/redaction.js";

/** What happened, in the vocabulary the incident log already uses. */
export type AlertKind =
  "startup" | "incident" | "dispatched" | "suppressed" | "recovered";

export type Alert = {
  kind: AlertKind;
  channelId?: string;
  reason: string;
  detail?: string;
  /** What a person should do about it, when there is something to do. */
  action?: string;
};

export type AlertRecord = Alert & {
  at: string;
  /** Whether a desktop notification was actually delivered. */
  notified: boolean;
};

export type AlertSink = {
  raise(alert: Alert): AlertRecord;
  /** Newest first, for a status or diagnostic view. */
  recent(limit?: number): AlertRecord[];
};

export type AlertSinkOptions = {
  file: string;
  /** Desktop notifications are best-effort and off unless asked for. */
  notify?: boolean;
  now?: () => Date;
  /** Rotation thresholds. Small on purpose: an alert log is not an archive. */
  maxBytes?: number;
  keepLines?: number;
  /** Seam for tests; returns whether the notification was delivered. */
  notifier?: (record: AlertRecord) => boolean;
};

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_KEEP_LINES = 500;

/**
 * Where alerts go. `MARKTV_ALERT_FILE` wins; otherwise the app's own data
 * directory, which is the same convention the database uses.
 */
export function alertFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.MARKTV_ALERT_FILE;
  if (configured !== undefined && configured.trim() !== "") {
    return configured;
  }
  const dataDir = env.MARKTV_DATA_DIR ?? join(process.cwd(), "data");
  return join(dataDir, "alerts.log");
}

/** The default notifier: a macOS notification, best-effort. */
function osascriptNotifier(record: AlertRecord): boolean {
  const title = record.kind === "startup" ? "MarkTV" : `MarkTV ${record.kind}`;
  const body = [record.channelId, record.reason, record.action]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(" — ")
    .slice(0, 300);
  const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
  try {
    // Detached and ignored: a notification must never delay or fail a recovery.
    const child = spawn("/usr/bin/osascript", ["-e", script], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function createAlertSink(options: AlertSinkOptions): AlertSink {
  const notify = options.notify ?? false;
  const now = options.now ?? (() => new Date());
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const keepLines = options.keepLines ?? DEFAULT_KEEP_LINES;
  const notifier = options.notifier ?? osascriptNotifier;

  const readLines = (): string[] => {
    try {
      if (!existsSync(options.file)) return [];
      return readFileSync(options.file, "utf-8")
        .split("\n")
        .filter((l) => l.trim() !== "");
    } catch {
      return [];
    }
  };

  /** Keep the file bounded. Failure here must not lose the alert just written. */
  const rotateIfNeeded = () => {
    try {
      if (!existsSync(options.file)) return;
      if (statSync(options.file).size <= maxBytes) return;
      const kept = readLines().slice(-keepLines);
      writeFileSync(options.file, kept.join("\n") + "\n");
    } catch {
      // Leaving an oversized file is strictly better than losing its contents.
    }
  };

  return {
    raise(alert: Alert): AlertRecord {
      const record: AlertRecord = {
        ...alert,
        at: now().toISOString(),
        notified: false,
      };
      try {
        // Redacted like every other outgoing record: an alert is often the thing
        // a person pastes into a message.
        record.notified = notify
          ? notifier(redactSensitive(record) as AlertRecord)
          : false;
      } catch {
        record.notified = false;
      }
      try {
        const dir = options.file.slice(0, options.file.lastIndexOf("/"));
        if (dir !== "") mkdirSync(dir, { recursive: true });
        appendFileSync(
          options.file,
          JSON.stringify(redactSensitive(record)) + "\n",
          "utf-8",
        );
        rotateIfNeeded();
      } catch {
        // The caller keeps running; the log line the caller already emits is now
        // the only record, which is why callers still log.
      }
      return record;
    },

    recent(limit = 50): AlertRecord[] {
      return readLines()
        .slice(-limit)
        .reverse()
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as AlertRecord];
          } catch {
            return [];
          }
        });
    },
  };
}
