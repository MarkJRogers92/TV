import type { TechnicalState } from "../types";

export const acquisitionStateLabels: Record<TechnicalState, string> = {
  wanted: "Wanted",
  "waiting-provider": "Waiting for provider",
  "match-found": "Match found",
  "retry-wait": "Waiting for provider",
  downloading: "Downloading",
  verifying: "Verifying",
  placing: "Verifying",
  imported: "Imported",
  "needs-review": "Needs review",
  cancelled: "Cancelled",
};

export function formatBytes(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (value < 1024) return `${value} B`;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(1)} ${units[unit]}`;
}

export function AcquisitionStatus({
  state,
  receivedBytes,
  expectedBytes,
}: {
  state: TechnicalState | null;
  receivedBytes?: number | null;
  expectedBytes?: number | null;
}) {
  if (state === null) return <span>No activity</span>;
  const label = acquisitionStateLabels[state] ?? state;
  const received =
    typeof receivedBytes === "number" ? receivedBytes : null;
  const expected =
    typeof expectedBytes === "number" ? expectedBytes : null;
  let progress: string | null = null;
  if (received !== null && expected !== null && expected > 0) {
    const percent = Math.min(
      100,
      Math.round((received / expected) * 100),
    );
    progress = `${formatBytes(received)} of ${formatBytes(expected)} (${percent}%)`;
  } else if (received !== null && received > 0) {
    progress = `${formatBytes(received)} received`;
  }
  return (
    <span>
      <strong>{label}</strong>
      {progress ? <span> · {progress}</span> : null}
    </span>
  );
}
