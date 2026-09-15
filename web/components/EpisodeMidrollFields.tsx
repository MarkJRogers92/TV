import type { Channel } from "../types";

type Slot = Channel["slots"][number];
type Midroll = NonNullable<Slot["episodeMidroll"]>;

const numberValue = (value: string) => Number(value) || 0;

export const defaultEpisodeMidroll: Midroll = {
  targetMinutes: [7.5, 15],
  searchWindowMinutes: 1.5,
  breakMinutes: 2.5,
  minimumSegmentMinutes: 2,
  tailBufferMinutes: 2,
};

export function EpisodeMidrollFields({
  labelPrefix,
  midroll,
  onChange,
}: {
  labelPrefix: string;
  midroll: Midroll;
  onChange: (midroll: Midroll) => void;
}) {
  const changeTarget = (index: 0 | 1, value: string) => {
    const targetMinutes: [number, number] = [...midroll.targetMinutes];
    targetMinutes[index] = numberValue(value);
    onChange({ ...midroll, targetMinutes });
  };
  return (
    <>
      <label>
        {labelPrefix} first break target minutes
        <input
          type="number"
          min="0.1"
          step="0.01"
          value={midroll.targetMinutes[0]}
          onChange={(event) => changeTarget(0, event.target.value)}
        />
      </label>
      <label>
        {labelPrefix} second break target minutes
        <input
          type="number"
          min="0.1"
          step="0.01"
          value={midroll.targetMinutes[1]}
          onChange={(event) => changeTarget(1, event.target.value)}
        />
      </label>
      {(
        [
          ["search window minutes", "searchWindowMinutes"],
          ["commercial break minutes", "breakMinutes"],
          ["minimum content segment minutes", "minimumSegmentMinutes"],
          ["episode tail buffer minutes", "tailBufferMinutes"],
        ] as const
      ).map(([label, property]) => (
        <label key={property}>
          {labelPrefix} {label}
          <input
            type="number"
            min="0.1"
            step="0.01"
            value={midroll[property]}
            onChange={(event) =>
              onChange({
                ...midroll,
                [property]: numberValue(event.target.value),
              })
            }
          />
        </label>
      ))}
    </>
  );
}
