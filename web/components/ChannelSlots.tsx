import type { Channel, Pool } from "../types";
import { MovieMidrollFields } from "./MovieMidrollFields";
import {
  defaultEpisodeMidroll,
  EpisodeMidrollFields,
} from "./EpisodeMidrollFields";

const numberValue = (value: string) => Number(value) || 0;

export function ChannelSlots({
  channel,
  pools,
  onChannelChange,
  onPoolsChange,
}: {
  channel: Channel;
  pools: Pool[];
  onChannelChange: (channel: Channel) => void;
  onPoolsChange: (pools: Pool[]) => void;
}) {
  const referencedPoolIds = Array.from(
    new Set(
      channel.slots.flatMap((slot) => [
        ...slot.poolIds,
        ...slot.fallbackPoolIds,
      ]),
    ),
  );
  const referencedPools = referencedPoolIds
    .map((id) => pools.find((pool) => pool.id === id))
    .filter((pool): pool is Pool => Boolean(pool));
  const changeSlot = (
    index: number,
    patch: Partial<Channel["slots"][number]>,
  ) =>
    onChannelChange({
      ...channel,
      slots: channel.slots.map((slot, itemIndex) =>
        itemIndex === index ? { ...slot, ...patch } : slot,
      ),
    });
  const changePool = (poolId: string, patch: Partial<Pool>) => {
    onPoolsChange(
      pools.map((pool) => (pool.id === poolId ? { ...pool, ...patch } : pool)),
    );
  };
  const poolIds = (value: string) =>
    value
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);

  return (
    <fieldset>
      <legend>Slots and selection</legend>
      {channel.slots.map((slot, index) => (
        <div className="form-grid" key={slot.id}>
          <label>
            {index ? `Slot ${index + 1} name` : "Slot name"}
            <input value={slot.id} readOnly />
          </label>
          <label>
            {index ? `Slot ${index + 1} time` : "Slot time"}
            <input
              type="time"
              value={slot.time ?? ""}
              onChange={(event) =>
                changeSlot(index, { time: event.target.value || undefined })
              }
            />
          </label>
          <label>
            {index ? `Slot ${index + 1} pool IDs` : "Slot pool IDs"}
            <input
              value={slot.poolIds.join(",")}
              onChange={(event) =>
                changeSlot(index, { poolIds: poolIds(event.target.value) })
              }
              list="channel-pool-ids"
            />
          </label>
          <label>
            {index ? `Slot ${index + 1} kind` : "Slot kind"}
            <select
              value={slot.kind}
              onChange={(event) =>
                changeSlot(index, {
                  kind: event.target.value as "episode" | "movie",
                })
              }
            >
              <option value="episode">episode</option>
              <option value="movie">movie</option>
            </select>
          </label>
          <label>
            {index ? `Slot ${index + 1} daypart` : "Slot daypart"}
            <select
              value={slot.daypartId ?? ""}
              onChange={(event) =>
                changeSlot(index, {
                  daypartId: event.target.value || undefined,
                })
              }
            >
              <option value="">Fixed-time slot</option>
              {channel.dayparts.map((daypart) => (
                <option value={daypart.id} key={daypart.id}>
                  {daypart.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {index
              ? `Slot ${index + 1} fallback pool IDs`
              : "Slot fallback pool IDs"}
            <input
              value={slot.fallbackPoolIds.join(",")}
              onChange={(event) =>
                changeSlot(index, {
                  fallbackPoolIds: poolIds(event.target.value),
                })
              }
              list="channel-pool-ids"
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={slot.allowCooldownRelaxation ?? false}
              onChange={(event) =>
                changeSlot(index, {
                  allowCooldownRelaxation: event.target.checked,
                })
              }
            />{" "}
            {index
              ? `Slot ${index + 1} may relax cooldown`
              : "Slot may relax cooldown"}
          </label>
          {slot.movieMidroll ? (
            <MovieMidrollFields
              midroll={slot.movieMidroll}
              onChange={(movieMidroll) => changeSlot(index, { movieMidroll })}
            />
          ) : null}
          {slot.kind === "episode" ? (
            <label>
              <input
                type="checkbox"
                checked={Boolean(slot.episodeMidroll)}
                onChange={(event) =>
                  changeSlot(index, {
                    episodeMidroll: event.target.checked
                      ? defaultEpisodeMidroll
                      : undefined,
                  })
                }
              />{" "}
              Slot {index + 1} episode mid-show breaks
            </label>
          ) : null}
          {slot.episodeMidroll ? (
            <EpisodeMidrollFields
              labelPrefix={`Slot ${index + 1}`}
              midroll={slot.episodeMidroll}
              onChange={(episodeMidroll) =>
                changeSlot(index, { episodeMidroll })
              }
            />
          ) : null}
          <button
            type="button"
            className="secondary"
            onClick={() =>
              onChannelChange({
                ...channel,
                slots: channel.slots.filter(
                  (_, itemIndex) => itemIndex !== index,
                ),
              })
            }
          >
            Remove {slot.id}
          </button>
        </div>
      ))}
      <button
        type="button"
        className="secondary"
        onClick={() =>
          onChannelChange({
            ...channel,
            slots: [
              ...channel.slots,
              {
                id: `slot-${channel.slots.length + 1}`,
                days: [],
                daypartId: channel.dayparts[0]?.id,
                poolIds: pools[0] ? [pools[0].id] : [""],
                kind: "episode",
                fallbackPoolIds: [],
              },
            ],
          })
        }
      >
        Add slot
      </button>
      <datalist id="channel-pool-ids">
        {pools.map((pool) => (
          <option value={pool.id} key={pool.id} />
        ))}
      </datalist>
      {referencedPools.map((pool, index) => (
        <div className="form-grid" key={pool.id}>
          <h3>{pool.name} selection</h3>
          <label>
            {index ? `Selection mode for ${pool.name}` : "Selection mode"}
            <select
              value={pool.mode}
              onChange={(event) =>
                changePool(pool.id, {
                  mode: event.target.value as Pool["mode"],
                })
              }
            >
              <option value="chronological">chronological</option>
              <option value="shuffle">shuffle</option>
            </select>
          </label>
          <label>
            {index ? `No-repeat minutes for ${pool.name}` : "No-repeat minutes"}
            <input
              type="number"
              value={pool.noRepeatMinutes}
              onChange={(event) =>
                changePool(pool.id, {
                  noRepeatMinutes: numberValue(event.target.value),
                })
              }
            />
          </label>
          <label>
            {index ? `Weight for ${pool.name}` : "Weight"}
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={pool.weight}
              onChange={(event) =>
                changePool(pool.id, {
                  weight: numberValue(event.target.value),
                })
              }
            />
          </label>
        </div>
      ))}
    </fieldset>
  );
}
