import { useEffect, useState } from "react";
import { markTvApi, type MarkTvApi } from "../api";
import { StatusCard } from "../components/StatusCard";
import type { AirStatus } from "../types";

export function Dashboard({
  client = markTvApi,
  channelId = "marktv-laughs",
}: {
  client?: MarkTvApi;
  channelId?: string;
}) {
  const [status, setStatus] = useState<AirStatus>();
  const [error, setError] = useState("");
  useEffect(() => {
    client
      .getAir(channelId)
      .then(setStatus)
      .catch(() => setError("Dashboard data is unavailable."));
  }, [client, channelId]);
  return (
    <section>
      <p className="eyebrow">
        {status
          ? `${status.channel.name} · Channel ${status.channel.number}`
          : "Loading channel…"}
      </p>
      <h2>Dashboard</h2>
      {error ? <p role="alert">{error}</p> : null}
      {status ? (
        <>
          <div className="status-line">
            <strong>{status.scheduleStatus}</strong>
            <span>
              Current time · {status.currentTime.slice(11, 16)} (
              {status.channel.timezone})
            </span>
          </div>
          <div className="cards">
            <StatusCard title="Now Playing">
              <p>{status.nowPlaying?.title ?? "Nothing scheduled"}</p>
            </StatusCard>
            <StatusCard title="Up Next">
              <p>{status.upNext?.title ?? "Nothing scheduled"}</p>
            </StatusCard>
          </div>
        </>
      ) : (
        <p>Loading schedule…</p>
      )}
    </section>
  );
}
