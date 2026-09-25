import { useCallback, useEffect, useState } from "react";
import { markTvApi, type AutopilotStatus } from "../api";
import { StatusCard } from "../components/StatusCard";

function dateTime(value: string | null | undefined): string {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function duration(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "Not available";
  const sign = value < 0 ? "−" : "+";
  const seconds = Math.round(Math.abs(value) / 1000);
  return `${sign}${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function bytes(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return "Not available";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function Health() {
  const [status, setStatus] = useState<AutopilotStatus>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setStatus(await markTvApi.autopilotStatus());
    } catch {
      setError("Health status is unavailable. Check that MarkTV is running, then retry.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section>
      <div className="dashboard-heading">
        <div>
          <p className="eyebrow">Read-only system snapshot</p>
          <h2>Health</h2>
        </div>
        <button type="button" className="secondary" onClick={() => void refresh()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh status"}
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {status ? (
        <>
          <p className="health-updated">Snapshot time · {dateTime(status.at)}</p>
          <div className="cards">
            <StatusCard title="Media preparation">
              <p>Registered intakes · {status.preparation.intakes}</p>
              <ul>
                {Object.entries(status.preparation.jobs).map(([state, count]) => (
                  <li key={state}>{state} jobs · {count}</li>
                ))}
              </ul>
              <h3>Classifications</h3>
              <ul>
                {Object.entries(status.preparation.classifications).map(([value, count]) => (
                  <li key={value}>{value.replaceAll("_", " ")} · {count}</li>
                ))}
              </ul>
              {status.preparation.recent.length ? (
                <details>
                  <summary>Recent preparation jobs ({status.preparation.recent.length})</summary>
                  <ul>
                    {status.preparation.recent.map((job, index) => (
                      <li key={`${job.path}-${index}`}>
                        <span>{job.state}{job.classification ? ` · ${job.classification.replaceAll("_", " ")}` : ""}</span>
                        <code className="health-path">{job.path}</code>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : <p>No recent preparation jobs are recorded.</p>}
            </StatusCard>

            <StatusCard title="Media roots">
              {status.mediaRoots.length ? (
                <ul className="health-list">
                  {status.mediaRoots.map((root) => (
                    <li key={root.path}>
                      <strong>{root.present ? "Present" : "Missing"}</strong>
                      <code className="health-path">{root.path}</code>
                      {root.present ? <span>Free space · {bytes(root.freeBytes)}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : <p>No media roots are registered.</p>}
            </StatusCard>

            <StatusCard title="Channel schedule coverage">
              <p className="health-note">Committed schedule metadata for the next 72 hours. This does not confirm what actually aired.</p>
              {status.channels.length ? status.channels.map((channel) => (
                <section className="health-channel" key={channel.id}>
                  <h3>{channel.name}</h3>
                  <p>{channel.hoursCovered} scheduled hours · {channel.gaps} gaps · {channel.contiguous ? "contiguous" : "has gaps"}</p>
                  <p>Scheduled now · {channel.air.onAir?.title ?? "No committed entry covers the current time"}</p>
                  <p>Next scheduled · {channel.air.next[0]?.title ?? "No upcoming entry in the schedule"}</p>
                  <details>
                    <summary>24-hour incident counts</summary>
                    <ul>
                      {Object.entries(channel.incidents).map(([name, count]) => <li key={name}>{name} · {count}</li>)}
                    </ul>
                  </details>
                </section>
              )) : <p>No channels are registered.</p>}
            </StatusCard>

            <StatusCard title="Observed playout checks">
              <p className="health-note">These values come from the latest available producer and served-playlist samples.</p>
              {status.playout.length ? status.playout.map((sample) => (
                <section className="health-channel" key={sample.channelId}>
                  <h3>{sample.channelId}</h3>
                  <p>Sampled · {dateTime(sample.checkedAt)}</p>
                  <p>Producer segment · {sample.newestSegment ?? "Not readable"}</p>
                  <p>Served segment · {sample.servedSegment ?? "Not readable"}</p>
                  <p>Served timestamp difference · {duration(sample.servedDeltaMs)}</p>
                  <p>Producer advanced since previous sample · {sample.advancing ? "Yes" : "No"}</p>
                  <p>Continuity check · {sample.health ?? "No verdict available"}</p>
                </section>
              )) : <p>No playout samples are available yet.</p>}
            </StatusCard>

            <StatusCard title="Recent alerts">
              <p className="health-note">Up to the 20 newest alert records.</p>
              {status.alerts.length ? (
                <ul className="health-list">
                  {status.alerts.map((alert, index) => (
                    <li key={`${alert.at}-${index}`}>
                      <strong>{alert.kind}{alert.channelId ? ` · ${alert.channelId}` : ""}</strong>
                      <span>{dateTime(alert.at)}</span>
                      <span>{alert.reason}</span>
                      {alert.detail ? <span>{alert.detail}</span> : null}
                      {alert.action ? <span>Suggested action · {alert.action}</span> : null}
                      <span>Desktop notification delivered · {alert.notified ? "Yes" : "No"}</span>
                    </li>
                  ))}
                </ul>
              ) : <p>No recent alert records.</p>}
            </StatusCard>
          </div>
        </>
      ) : !error ? <p>Loading health status…</p> : null}
    </section>
  );
}
