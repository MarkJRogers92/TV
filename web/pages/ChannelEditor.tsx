import { useEffect, useState } from "react";
import { markTvApi, type MarkTvApi } from "../api";
import { ChannelBreakPolicy } from "../components/ChannelBreakPolicy";
import { ChannelIdentityDayparts } from "../components/ChannelIdentityDayparts";
import { ChannelSlots } from "../components/ChannelSlots";
import type { ApiError, Channel, Pool } from "../types";

export function ChannelEditor({
  client = markTvApi,
  channelId = "marktv-laughs",
}: {
  client?: MarkTvApi;
  channelId?: string;
}) {
  const [channel, setChannel] = useState<Channel>();
  const [pools, setPools] = useState<Pool[]>([]);
  const [message, setMessage] = useState("");
  const [issues, setIssues] = useState<
    Array<{ path: string; message: string }>
  >([]);

  useEffect(() => {
    Promise.all([client.getChannel(channelId), client.listPools()])
      .then(([loadedChannel, loadedPools]) => {
        setChannel(loadedChannel);
        setPools(loadedPools);
      })
      .catch(() => setMessage("Channel configuration is unavailable."));
  }, [client, channelId]);

  if (!channel) {
    return (
      <section>
        <h2>Channel</h2>
        <p>{message || "Loading configuration…"}</p>
      </section>
    );
  }

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage("");
    setIssues([]);
    try {
      await client.updateChannel(channel);
      const referencedPoolIds = new Set(
        channel.slots.flatMap((slot) => [
          ...slot.poolIds,
          ...slot.fallbackPoolIds,
        ]),
      );
      await Promise.all(
        pools
          .filter((pool) => referencedPoolIds.has(pool.id))
          .map((pool) => client.updatePool(pool)),
      );
      setMessage("Channel saved.");
    } catch (caught) {
      const error = caught as ApiError;
      setIssues(
        error.issues?.length
          ? error.issues
          : [
              {
                path: error.code ?? "request",
                message: error.message ?? "Save failed",
              },
            ],
      );
    }
  };

  return (
    <section>
      <h2>Channel</h2>
      <form onSubmit={save}>
        <ChannelIdentityDayparts channel={channel} onChange={setChannel} />
        <ChannelSlots
          channel={channel}
          pools={pools}
          onChannelChange={setChannel}
          onPoolsChange={setPools}
        />
        <ChannelBreakPolicy channel={channel} onChange={setChannel} />
        {issues.length ? (
          <div role="alert">
            {issues.map((issue) => (
              <p key={`${issue.path}-${issue.message}`}>
                {issue.path}: {issue.message}
              </p>
            ))}
          </div>
        ) : null}
        {message ? <p className="success">{message}</p> : null}
        <button>Save channel</button>
      </form>
    </section>
  );
}
