import type { ScheduleEntry } from "../types";

export function ScheduleTable({ entries }: { entries: ScheduleEntry[] }) {
  return (
    <div className="table-scroll">
      <table aria-label="Electronic program guide">
        <thead>
          <tr>
            <th>Start</th>
            <th>End</th>
            <th>Kind</th>
            <th>Title</th>
            <th>Daypart</th>
            <th>Slot</th>
            <th>Selection</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td>{entry.localStart}</td>
              <td>{entry.localEnd}</td>
              <td>{entry.kind}</td>
              <td>{entry.title}</td>
              <td>{entry.sourceDaypartId ?? "—"}</td>
              <td>{entry.sourceSlotId ?? entry.source ?? "—"}</td>
              <td>{entry.selectionExplanation ?? entry.reason ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
