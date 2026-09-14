import type { Channel } from "../types";

const numberValue = (value: string) => Number(value) || 0;

export function ChannelBreakPolicy({
  channel,
  onChange,
}: {
  channel: Channel;
  onChange: (channel: Channel) => void;
}) {
  const updatePolicy = (patch: Partial<Channel["breakPolicy"]>) =>
    onChange({
      ...channel,
      breakPolicy: { ...channel.breakPolicy, ...patch },
    });

  return (
    <fieldset>
      <legend>Break policy</legend>
      <div className="form-grid">
        <label>
          Break boundary minutes
          <input
            type="number"
            value={channel.breakPolicy.boundaryMinutes}
            onChange={(event) =>
              updatePolicy({ boundaryMinutes: numberValue(event.target.value) })
            }
          />
        </label>
        <label>
          Interstitial cooldown minutes
          <input
            type="number"
            value={channel.breakPolicy.cooldownMinutes}
            onChange={(event) =>
              updatePolicy({ cooldownMinutes: numberValue(event.target.value) })
            }
          />
        </label>
        <label>
          Interstitial pool IDs
          <input
            value={channel.breakPolicy.poolIds.join(",")}
            onChange={(event) =>
              updatePolicy({
                poolIds: event.target.value.split(",").filter(Boolean),
              })
            }
          />
        </label>
        <label>
          Station-ID pool IDs
          <input
            value={channel.breakPolicy.stationIdPoolIds.join(",")}
            onChange={(event) =>
              updatePolicy({
                stationIdPoolIds: event.target.value.split(",").filter(Boolean),
              })
            }
          />
        </label>
      </div>
    </fieldset>
  );
}
