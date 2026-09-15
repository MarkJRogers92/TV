import { useRef, useState } from "react";
import { api } from "../api";

type Connection = {
  url: string;
  version: string;
  supportsChannels?: boolean;
  supportsFillerLists?: boolean;
  supportsTranscodeConfigs?: boolean;
  supportsInventory?: boolean;
  supportsProgramming: boolean;
};
type Plan = {
  syncEligible: boolean;
  capabilities: { version: string };
  blockingErrors: { code: string; message?: string }[];
  warnings: { code: string; message?: string }[];
  matchCounts: {
    matched: number;
    unmatched: number;
    ambiguous: number;
    placeholder: number;
  };
  operations: { type: string }[];
};
type Result = Connection | Plan | { error: string };
const isConnection = (result: Result | undefined): result is Connection =>
  !!result && "supportsProgramming" in result;
const isPlan = (result: Result | undefined): result is Plan =>
  !!result && "syncEligible" in result;
const isError = (result: Result | undefined): result is { error: string } =>
  !!result && "error" in result;

export function parseLibraryIdsText(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(/\r?\n/)) {
    const trimmed = part.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function Tunarr() {
  const [url, setUrl] = useState("http://127.0.0.1:8000");
  const [libraryIdsText, setLibraryIdsText] = useState("");
  const [channelId, setChannelId] = useState("");
  const [createChannel, setCreateChannel] = useState(false);
  const [transcodeConfigId, setTranscodeConfigId] = useState("");
  const [result, setResult] = useState<Result>();
  const requestGeneration = useRef(0);
  const request = async <T,>(path: string, body?: unknown) => {
    const generation = ++requestGeneration.current;
    try {
      const nextResult = (await api<T>(path, {
        method: "POST",
        body: body ? JSON.stringify(body) : undefined,
      })) as Result;
      if (generation === requestGeneration.current) setResult(nextResult);
    } catch {
      if (generation === requestGeneration.current)
        setResult({
          error:
            "The Tunarr request failed. Check the connection and dry-run details.",
        });
    }
  };
  const change = (set: (value: string) => void) => (value: string) => {
    set(value);
    requestGeneration.current += 1;
    setResult(undefined);
  };
  return (
    <section>
      <h2>Tunarr</h2>
      <p>
        Test a local Tunarr connection, then request a dry run before any
        explicit sync.
      </p>
      <label>
        Tunarr URL
        <input
          value={url}
          onChange={(event) => change(setUrl)(event.target.value)}
        />
      </label>
      <label>
        Library IDs (one per line)
        <textarea
          value={libraryIdsText}
          onChange={(event) =>
            change(setLibraryIdsText)(event.target.value)
          }
        />
      </label>
      <label>
        Tunarr channel ID
        <input
          value={channelId}
          onChange={(event) => change(setChannelId)(event.target.value)}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={createChannel}
          onChange={(event) => {
            setCreateChannel(event.target.checked);
            requestGeneration.current += 1;
            setResult(undefined);
          }}
        />{" "}
        Create a new Tunarr channel
      </label>
      {createChannel ? (
        <label>
          Transcode configuration ID
          <input
            value={transcodeConfigId}
            onChange={(event) =>
              change(setTranscodeConfigId)(event.target.value)
            }
          />
        </label>
      ) : null}
      <button
        onClick={() =>
          request<Connection>("/tunarr/test", {
            url,
            libraryIds: parseLibraryIdsText(libraryIdsText),
            channelId,
          })
        }
      >
        Test connection
      </button>
      <button
        onClick={() =>
          request<Plan>("/tunarr/dry-run", {
            url,
            libraryIds: parseLibraryIdsText(libraryIdsText),
            channelId,
            createChannel,
            transcodeConfigId,
          })
        }
      >
        Dry run
      </button>
      {isConnection(result) && (
        <p>
          Connected: Tunarr {result.version}
          {result.supportsProgramming ? "" : " (programming unavailable)"}
          {result.supportsInventory === false ? " (inventory unavailable)" : ""}
        </p>
      )}
      {isPlan(result) && (
        <div>
          <p>
            Dry run: {result.syncEligible ? "eligible" : "blocked"}; version{" "}
            {result.capabilities.version}.
          </p>
          <p>
            Matched: {result.matchCounts.matched}; unmatched:{" "}
            {result.matchCounts.unmatched}; ambiguous:{" "}
            {result.matchCounts.ambiguous}; placeholders:{" "}
            {result.matchCounts.placeholder}.
          </p>
          <p>
            Operations:{" "}
            {result.operations.map((operation) => operation.type).join(", ") ||
              "none"}
          </p>
          {result.blockingErrors.map((error) => (
            <p key={error.code}>Blocked: {error.code}</p>
          ))}
          {result.warnings.map((warning) => (
            <p key={warning.code}>Warning: {warning.code}</p>
          ))}
        </div>
      )}
      {isError(result) && <p role="alert">{result.error}</p>}
      <button
        disabled={!isPlan(result) || !result.syncEligible}
        onClick={() => request("/tunarr/sync")}
      >
        Sync
      </button>
    </section>
  );
}
