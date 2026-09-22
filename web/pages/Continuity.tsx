import { useEffect, useState } from "react";
import { markTvApi, type MarkTvApi } from "../api";
import type {
  ApiError,
  ContinuityFrequency,
  ContinuityStatus,
  ContinuityUpdate,
  ContinuityWeirdness,
} from "../types";

const frequencies: ContinuityFrequency[] = ["low", "normal", "high"];
const weirdness: ContinuityWeirdness[] = ["off", "low", "normal"];

const formatInstant = (instant: string) => {
  const at = new Date(instant);
  return Number.isNaN(at.getTime())
    ? instant
    : at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};

export function Continuity({
  channelId,
  client = markTvApi,
}: {
  channelId: string;
  client?: MarkTvApi;
}) {
  const [status, setStatus] = useState<ContinuityStatus | null>(null);
  const [draft, setDraft] = useState<ContinuityUpdate>({});
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setStatus(null);
    setDraft({});
    setLoadError("");
    client
      .continuityStatus(channelId)
      .then(setStatus)
      .catch(() => setLoadError("Continuity status is unavailable."));
  }, [channelId, client]);

  const value = <T,>(key: keyof ContinuityStatus["config"], fallback: T): T =>
    (draft[key as keyof ContinuityUpdate] as unknown as T | undefined) ??
    (status?.config[key] as unknown as T | undefined) ??
    fallback;

  const save = async () => {
    if (!status) return;
    setActionError("");
    setNotice("");
    setSaving(true);
    try {
      const updated = await client.updateContinuity(channelId, draft);
      setStatus(updated);
      setDraft({});
      setNotice("Continuity Director settings saved.");
    } catch (caught) {
      setActionError((caught as ApiError).message);
    } finally {
      setSaving(false);
    }
  };

  const dirty = Object.keys(draft).length > 0;

  return (
    <section>
      <h2>Continuity Director</h2>
      <p>
        Continuity cards are planned from the completed schedule and only air once
        their rendered asset is registered for that exact lineup. Opening this page
        never renders or generates anything.
      </p>
      {loadError ? <p role="alert">{loadError}</p> : null}
      {actionError ? <p role="alert">{actionError}</p> : null}
      {notice ? <p className="success">{notice}</p> : null}
      {!status ? null : (
        <>
          <div className="cards">
            <article>
              <h3>{status.config.enabled ? "Director on" : "Director off"}</h3>
              <p>{status.activation.reason ?? "Planned cards are inserted where they fit exactly."}</p>
              <label>
                <input
                  type="checkbox"
                  checked={value<boolean>("enabled", true)}
                  disabled={saving}
                  onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                />
                Plan continuity cards
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={value<boolean>("nextCards", true)}
                  disabled={saving}
                  onChange={(event) => setDraft({ ...draft, nextCards: event.target.checked })}
                />
                NEXT and NEXT/LATER cards
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={status.config.stagedInterruptionsEnabled}
                  disabled
                  readOnly
                />
                Staged interruptions (separate playback-health gate)
              </label>
            </article>
            <article>
              <h3>Cadence</h3>
              <label>
                NEXT cards
                <select
                  aria-label="NEXT card frequency"
                  value={value<ContinuityFrequency>("nextLaterFrequency", "normal")}
                  disabled={saving}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      nextLaterFrequency: event.target.value as ContinuityFrequency,
                    })
                  }
                >
                  {frequencies.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                TONIGHT cards
                <select
                  aria-label="TONIGHT card frequency"
                  value={value<ContinuityFrequency>("tonightFrequency", "normal")}
                  disabled={saving}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      tonightFrequency: event.target.value as ContinuityFrequency,
                    })
                  }
                >
                  {frequencies.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                After-midnight humour
                <select
                  aria-label="Overnight weirdness"
                  value={value<ContinuityWeirdness>("overnightWeirdness", "low")}
                  disabled={saving}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      overnightWeirdness: event.target.value as ContinuityWeirdness,
                    })
                  }
                >
                  {weirdness.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <button disabled={saving || !dirty} onClick={() => void save()}>
                Save continuity settings
              </button>
            </article>
            <article>
              <h3>Readiness</h3>
              <p>
                Branding: {status.branding.state} ({status.branding.expectedFile})
              </p>
              <p>
                {status.assets.discovered} discovered · {status.assets.airReady} air-ready ·{" "}
                {status.assets.generated} schedule cards · {status.assets.scriptOnly} script-only ·{" "}
                {status.assets.quarantined} quarantined
              </p>
              <p>
                Network: {status.voices.network} · Local: {status.voices.local} · Overnight:{" "}
                {status.voices.overnight} · Odd: {status.voices.odd}
              </p>
            </article>
          </div>
          <article>
            <h3>Planned cards</h3>
            <p>
              {status.director.label} · revision {status.director.scheduleRevision}
            </p>
            <p>Now: {status.director.current ?? "No current editorial program"}</p>
            <p>Next: {status.director.next ?? "No confirmed next program"}</p>
            <p>Later: {status.director.later ?? "No confirmed later program"}</p>
            {status.director.cards.length ? (
              <ul>
                {status.director.cards.map((card) => (
                  <li key={`${card.cardType}-${card.insertionInstant}-${card.title}`}>
                    {formatInstant(card.insertionInstant)} · {card.cardType} · {card.family} ·{" "}
                    {card.label} {card.title}
                    {card.details.length ? ` · ${card.details.join(" · ")}` : ""} ·{" "}
                    {card.assetRegistered ? "asset registered" : "awaiting offline render"}
                  </li>
                ))}
              </ul>
            ) : (
              <p>Skipped: {status.director.skippedReason ?? "No eligible plan"}</p>
            )}
          </article>
        </>
      )}
    </section>
  );
}
