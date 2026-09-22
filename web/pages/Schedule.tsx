import { useEffect, useState } from "react";
import { markTvApi, type MarkTvApi } from "../api";
import { MovieProgrammingPanel } from "../components/MovieProgrammingPanel";
import { ScheduleTable } from "../components/ScheduleTable";
import type { ApiError, Schedule as ScheduleModel } from "../types";

const localToday = () => new Date().toLocaleDateString("en-CA");

export function Schedule({
  client = markTvApi,
  channelId = "marktv-laughs",
  today = localToday(),
}: {
  client?: MarkTvApi;
  channelId?: string;
  today?: string;
}) {
  const [schedule, setSchedule] = useState<ScheduleModel | null>();
  const [date, setDate] = useState(today);
  const [exportPath, setExportPath] = useState("");
  const [error, setError] = useState("");
  // Loaded by the date the form is showing, not "the newest row": the
  // quiet-hours pass stores tomorrow's schedule, which is newer than today's.
  useEffect(() => {
    let current = true;
    client
      .latestSchedule(channelId, date)
      // Ignored when the date moved on while this read was in flight, so a slow
      // answer for one day cannot replace the day being shown.
      .then((loaded) => {
        if (current) setSchedule(loaded);
      })
      .catch(() => {
        if (current) setError("Could not load the schedule for that date.");
      });
    return () => {
      current = false;
    };
  }, [client, channelId, date]);
  const generate = async () => {
    setError("");
    try {
      const result = await client.generateSchedule(channelId, date);
      setSchedule(result.schedule);
      setExportPath(result.exportPath);
    } catch (caught) {
      const apiError = caught as ApiError;
      setError(
        apiError.issues
          ?.map((issue) => `${issue.path}: ${issue.message}`)
          .join("; ") || apiError.message,
      );
    }
  };
  return (
    <section>
      <h2>Schedule</h2>
      <div className="toolbar">
        <label>
          Broadcast date
          <input
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </label>
        <button onClick={generate}>Generate schedule</button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {schedule ? (
        <>
          <p>
            {schedule.date} · {schedule.timezone}
          </p>
          <ScheduleTable entries={schedule.entries} />
          <h3>Diagnostics</h3>
          {schedule.diagnostics.length ? (
            <ul>
              {schedule.diagnostics.map((diagnostic, index) => (
                <li key={`${diagnostic.code}-${index}`}>
                  {diagnostic.message}
                </li>
              ))}
            </ul>
          ) : (
            <p>No diagnostics.</p>
          )}
          {exportPath ? (
            <p>
              <strong>Export:</strong> {exportPath}
            </p>
          ) : null}
        </>
      ) : (
        <p>Generate a schedule to preview the EPG.</p>
      )}
      <MovieProgrammingPanel client={client} channelId={channelId} />
    </section>
  );
}
