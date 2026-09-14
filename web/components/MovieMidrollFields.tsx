import type { Channel } from "../types";

type Slot = Channel["slots"][number];
type Midroll = NonNullable<Slot["movieMidroll"]>;
const numberValue = (value: string) => Number(value) || 0;

export function MovieMidrollFields({
  midroll,
  onChange,
}: {
  midroll: Midroll;
  onChange: (midroll: Midroll) => void;
}) {
  return (
    <>
      <label>
        Movie break interval
        <input
          type="number"
          value={midroll.intervalMinutes}
          onChange={(event) =>
            onChange({
              ...midroll,
              intervalMinutes: numberValue(event.target.value),
            })
          }
        />
      </label>
      <label>
        Movie break minutes
        <input
          type="number"
          value={midroll.breakMinutes}
          onChange={(event) =>
            onChange({
              ...midroll,
              breakMinutes: numberValue(event.target.value),
            })
          }
        />
      </label>
      <label>
        Movie minimum minutes
        <input
          type="number"
          value={midroll.minimumMinutes}
          onChange={(event) =>
            onChange({
              ...midroll,
              minimumMinutes: numberValue(event.target.value),
            })
          }
        />
      </label>
      <label>
        Movie maximum breaks
        <input
          type="number"
          value={midroll.maxBreaks}
          onChange={(event) =>
            onChange({
              ...midroll,
              maxBreaks: numberValue(event.target.value),
            })
          }
        />
      </label>
      <label>
        Movie tail buffer minutes
        <input
          type="number"
          value={midroll.tailBufferMinutes}
          onChange={(event) =>
            onChange({
              ...midroll,
              tailBufferMinutes: numberValue(event.target.value),
            })
          }
        />
      </label>
      <label>
        Movie break strategy
        <select
          value={midroll.strategy}
          onChange={(event) =>
            onChange({
              ...midroll,
              strategy: event.target.value as Midroll["strategy"],
            })
          }
        >
          <option value="lazy">lazy</option>
          <option value="eager">eager</option>
        </select>
      </label>
    </>
  );
}
