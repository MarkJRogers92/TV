import { useEffect, useState } from "react";
import { markTvApi, type MarkTvApi } from "../api";
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
  useEffect(() => {
    client
      .latestSchedule(channelId)
      .then(setSchedule)
      .catch(() => setError("Could not load the latest schedule."));
  }, [client, channelId]);
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
    </section>
  );
}
