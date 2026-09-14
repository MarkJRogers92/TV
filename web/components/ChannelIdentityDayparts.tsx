import type { Channel } from "../types";

const numberValue = (value: string) => Number(value) || 0;

export function ChannelIdentityDayparts({
  channel,
  onChange,
}: {
  channel: Channel;
  onChange: (channel: Channel) => void;
}) {
  const changeDaypart = (
    index: number,
    patch: Partial<Channel["dayparts"][number]>,
  ) =>
    onChange({
      ...channel,
      dayparts: channel.dayparts.map((daypart, itemIndex) =>
        itemIndex === index ? { ...daypart, ...patch } : daypart,
      ),
    });

  return (
    <>
      <fieldset>
        <legend>Identity</legend>
        <label>
          Channel name
          <input
            value={channel.name}
            onChange={(event) =>
              onChange({ ...channel, name: event.target.value })
            }
          />
        </label>
        <label>
          Channel number
          <input
            type="number"
            value={channel.number}
            onChange={(event) =>
              onChange({
                ...channel,
                number: numberValue(event.target.value),
              })
            }
          />
        </label>
        <label>
          Timezone
          <input
            value={channel.timezone}
            onChange={(event) =>
              onChange({ ...channel, timezone: event.target.value })
            }
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={channel.enabled}
            onChange={(event) =>
              onChange({ ...channel, enabled: event.target.checked })
            }
          />{" "}
          Channel enabled
        </label>
      </fieldset>
      <fieldset>
        <legend>Dayparts</legend>
        {channel.dayparts.map((daypart, index) => (
          <div className="form-grid" key={daypart.id}>
            <label>
              {index ? `Daypart ${index + 1} name` : "Daypart name"}
              <input
                value={daypart.name}
                onChange={(event) =>
                  changeDaypart(index, { name: event.target.value })
                }
              />
            </label>
            <label>
              {index ? `Daypart ${index + 1} start` : "Daypart start"}
              <input
                type="time"
                value={daypart.start}
                onChange={(event) =>
                  changeDaypart(index, { start: event.target.value })
                }
              />
            </label>
            <label>
              {index ? `Daypart ${index + 1} end` : "Daypart end"}
              <input
                type="time"
                value={daypart.end}
                onChange={(event) =>
                  changeDaypart(index, { end: event.target.value })
                }
              />
            </label>
            <label>
              {index ? `Daypart ${index + 1} priority` : "Daypart priority"}
              <input
                type="number"
                value={daypart.priority}
                onChange={(event) =>
                  changeDaypart(index, {
                    priority: numberValue(event.target.value),
                  })
                }
              />
            </label>
            <label>
              {index ? `Daypart ${index + 1} days` : "Daypart days"}
              <input
                value={daypart.days.join(",")}
                onChange={(event) =>
                  changeDaypart(index, {
                    days: event.target.value.split(",").map(numberValue),
                  })
                }
              />
            </label>
            <button
              type="button"
              className="secondary"
              onClick={() =>
                onChange({
                  ...channel,
                  dayparts: channel.dayparts.filter(
                    (_, itemIndex) => itemIndex !== index,
                  ),
                })
              }
            >
              Remove {daypart.name}
            </button>
          </div>
        ))}
        <button
          type="button"
          className="secondary"
          onClick={() =>
            onChange({
              ...channel,
              dayparts: [
                ...channel.dayparts,
                {
                  id: `daypart-${channel.dayparts.length + 1}`,
                  name: "New daypart",
                  days: [0, 1, 2, 3, 4, 5, 6],
                  start: "09:00",
                  end: "17:00",
                  priority: 1,
                },
              ],
            })
          }
        >
          Add daypart
        </button>
      </fieldset>
    </>
  );
}
