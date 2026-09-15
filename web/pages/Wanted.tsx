import { useEffect, useState } from "react";
import { markTvApi, type MarkTvApi } from "../api";
import { AcquisitionStatus, formatBytes } from "../components/AcquisitionStatus";
import type { ApiError, SeasonPackView, WantedView } from "../types";

function episodeCode(season: number, episode: number): string {
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

const terminalStates = new Set(["imported", "cancelled"]);

function hasNonterminalAcquisition(wanted: readonly WantedView[]): boolean {
  return wanted.some((entry) =>
    !terminalStates.has(entry.status) || (entry.job !== null && !terminalStates.has(entry.job.state)),
  );
}

function hasCompetingCollection(
  packs: readonly SeasonPackView[],
  pack: SeasonPackView,
): boolean {
  return pack.seriesTitle !== null && pack.season !== null && packs.filter(
    (candidate) =>
      candidate.seriesTitle === pack.seriesTitle && candidate.season === pack.season,
  ).length > 1;
}

export function Wanted({ client = markTvApi }: { client?: MarkTvApi }) {
  const [wanted, setWanted] = useState<WantedView[]>([]);
  const [packs, setPacks] = useState<SeasonPackView[]>([]);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [seriesTitle, setSeriesTitle] = useState("");
  const [season, setSeason] = useState("");
  const [episode, setEpisode] = useState("");
  const [episodeTitle, setEpisodeTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedCandidates, setSelectedCandidates] = useState<Record<string, { candidateIndex: number; reviewUpdatedAt: string } | undefined>>({});

  useEffect(() => {
    Promise.all([client.listWanted(), client.listSeasonPacks()])
      .then(([loadedWanted, loadedPacks]) => {
        setWanted(loadedWanted);
        setPacks(loadedPacks);
      })
      .catch(() => setLoadError("Wanted data is unavailable."));
  }, [client]);

  useEffect(() => {
    if (!hasNonterminalAcquisition(wanted)) return;
    let disposed = false;
    let inFlight = false;
    const refreshActive = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const [loadedWanted, loadedPacks] = await Promise.all([
          client.listWanted(),
          client.listSeasonPacks(),
        ]);
        if (!disposed) {
          setWanted(loadedWanted);
          setPacks(loadedPacks);
        }
      } catch {
        // Background refresh deliberately stays quiet; explicit actions keep
        // their existing safe error surface.
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => { void refreshActive(); }, 5_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [client, wanted]);

  useEffect(() => {
    const activeReviewVersions = new Map(
      wanted.flatMap((entry) => entry.review ? [[entry.review.id, entry.review.updatedAt] as const] : []),
    );
    setSelectedCandidates((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([reviewId, selection]) =>
          selection !== undefined && activeReviewVersions.get(reviewId) === selection.reviewUpdatedAt,
        ),
      );
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [wanted]);

  const refresh = async () => {
    try {
      const [loadedWanted, loadedPacks] = await Promise.all([
        client.listWanted(),
        client.listSeasonPacks(),
      ]);
      setWanted(loadedWanted);
      setPacks(loadedPacks);
    } catch (caught) {
      setActionError((caught as ApiError).message);
    }
  };

  const add = async () => {
    setActionError("");
    setNotice("");
    const seasonValue = season.trim();
    const episodeValue = episode.trim();
    const seasonNumber = Number(seasonValue);
    const episodeNumber = Number(episodeValue);
    if (!seriesTitle.trim() || !seasonValue || !episodeValue || !Number.isInteger(seasonNumber) || !Number.isInteger(episodeNumber)) {
      setActionError("Enter a series title, season, and episode.");
      return;
    }
    setBusy(true);
    try {
      const created = await client.addWanted({
        seriesTitle: seriesTitle.trim(),
        season: seasonNumber,
        episode: episodeNumber,
        episodeTitle: episodeTitle.trim() ? episodeTitle.trim() : null,
      });
      setWanted((current) => [...current, created]);
      setSeriesTitle("");
      setSeason("");
      setEpisode("");
      setEpisodeTitle("");
      setNotice(`Added ${created.seriesTitle} ${episodeCode(created.season, created.episode)}.`);
    } catch (caught) {
      setActionError((caught as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (entry: WantedView) => {
    setActionError("");
    setNotice("");
    try {
      await client.removeWanted(entry.id);
      setWanted((current) => current.filter((item) => item.id !== entry.id));
      setNotice(`Removed ${entry.seriesTitle} ${episodeCode(entry.season, entry.episode)}.`);
    } catch (caught) {
      setActionError((caught as ApiError).message);
    }
  };

  const retry = async (jobId: string) => {
    setActionError("");
    setNotice("");
    try {
      await client.retryJob(jobId);
      setNotice("Retry queued for the acquisition job.");
      await refresh();
    } catch (caught) {
      setActionError((caught as ApiError).message);
    }
  };

  const cancel = async (jobId: string) => {
    setActionError("");
    setNotice("");
    try {
      await client.cancelJob(jobId);
      setNotice("Cancellation requested for the acquisition job.");
      await refresh();
    } catch (caught) {
      setActionError((caught as ApiError).message);
    }
  };

  const importSeason = async (packId: string) => {
    setActionError("");
    setNotice("");
    try {
      const result = await client.importSeason(packId);
      setNotice(
        `Season import scheduled for ${result.wantedIds.length} episode(s).`,
      );
      await refresh();
    } catch (caught) {
      setActionError((caught as ApiError).message);
    }
  };

  const selectCandidate = async (reviewId: string, reviewUpdatedAt: string) => {
    const selection = selectedCandidates[reviewId];
    if (!selection || selection.reviewUpdatedAt !== reviewUpdatedAt) return;
    setActionError("");
    setNotice("");
    try {
      await client.selectCandidate(reviewId, { candidateIndex: selection.candidateIndex, reviewUpdatedAt });
      setNotice("Candidate selected and acquisition scheduled.");
      await refresh();
    } catch (caught) {
      setActionError((caught as ApiError).message);
    }
  };

  return (
    <section>
      <h2>Wanted</h2>
      <p>Track episodes MarkTV should acquire. Links open the Stremio search for each episode.</p>
      {loadError ? <p role="alert">{loadError}</p> : null}
      {actionError ? <p role="alert">{actionError}</p> : null}
      {notice ? <p className="success">{notice}</p> : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <fieldset>
          <legend>Add a wanted episode</legend>
          <div className="form-grid">
            <label>
              Series title
              <input
                aria-label="Series title"
                value={seriesTitle}
                onChange={(event) => setSeriesTitle(event.target.value)}
              />
            </label>
            <label>
              Season
              <input
                aria-label="Season"
                inputMode="numeric"
                value={season}
                onChange={(event) => setSeason(event.target.value)}
              />
            </label>
            <label>
              Episode
              <input
                aria-label="Episode"
                inputMode="numeric"
                value={episode}
                onChange={(event) => setEpisode(event.target.value)}
              />
            </label>
            <label>
              Episode title (optional)
              <input
                aria-label="Episode title (optional)"
                value={episodeTitle}
                onChange={(event) => setEpisodeTitle(event.target.value)}
              />
            </label>
          </div>
          <button type="submit" disabled={busy}>
            Add episode
          </button>
        </fieldset>
      </form>
      <h3>Wanted episodes ({wanted.length})</h3>
      {wanted.length === 0 ? (
        <p>No wanted episodes yet.</p>
      ) : (
        <div className="cards">
          {wanted.map((entry) => (
            <article key={entry.id}>
              <h4>
                {entry.seriesTitle} {episodeCode(entry.season, entry.episode)}
              </h4>
              {entry.episodeTitle ? <p>{entry.episodeTitle}</p> : null}
              <p>
                Episode status: <AcquisitionStatus state={entry.status} />
              </p>
              {entry.job ? (
                <p>
                  Job {entry.job.provider} · attempt {entry.job.attempt} of{" "}
                  {entry.job.maxAttempts}:{" "}
                  <AcquisitionStatus
                    state={entry.job.state}
                    receivedBytes={entry.job.receivedBytes}
                    expectedBytes={entry.job.expectedBytes}
                  />
                  {entry.job.cancelRequested ? <span> · cancel requested</span> : null}
                </p>
              ) : (
                <p>No acquisition job yet.</p>
              )}
              {entry.review ? (
                <div>
                  <p>
                    Needs review: {entry.review.message}
                    {entry.review.candidateCount > 0
                      ? ` (${entry.review.candidateCount} candidate(s))`
                      : null}
                  </p>
                  {entry.review.candidates.length > 0 &&
                  (entry.review.kind === "ambiguous" || entry.review.kind === "uncertain-title") ? (
                    <fieldset>
                      <legend>Choose a file deliberately</legend>
                      {entry.review.candidates.map((candidate) => (
                        <label key={candidate.candidateIndex}>
                          <input
                            type="radio"
                            name={`candidate-${entry.review?.id}`}
                            aria-label={`Select ${candidate.filename}`}
                            checked={selectedCandidates[entry.review!.id]?.reviewUpdatedAt === entry.review!.updatedAt && selectedCandidates[entry.review!.id]?.candidateIndex === candidate.candidateIndex}
                            onChange={() => setSelectedCandidates((current) => ({
                              ...current,
                              [entry.review!.id]: {
                                candidateIndex: candidate.candidateIndex,
                                reviewUpdatedAt: entry.review!.updatedAt,
                              },
                            }))}
                          />
                          {candidate.filename} · {candidate.provider}
                          {candidate.resolution ? ` · ${candidate.resolution}` : ""}
                          {candidate.sizeBytes !== null ? ` · ${formatBytes(candidate.sizeBytes)}` : ""}
                        </label>
                      ))}
                      <button
                        disabled={selectedCandidates[entry.review.id]?.reviewUpdatedAt !== entry.review.updatedAt}
                        onClick={() => void selectCandidate(entry.review!.id, entry.review!.updatedAt)}
                      >
                        Use selected candidate
                      </button>
                    </fieldset>
                  ) : entry.review.kind === "multi-episode" ? (
                    <p>This file cannot be selected as a single episode.</p>
                  ) : null}
                </div>
              ) : null}
              <p>
                <a href={entry.stremioUrl}>Open in Stremio</a>
              </p>
              <div>
                {entry.job ? (
                  <>
                    <button onClick={() => void retry(entry.job?.id ?? "")}>
                      Retry job
                    </button>
                    <button
                      className="secondary"
                      onClick={() => void cancel(entry.job?.id ?? "")}
                    >
                      Cancel job
                    </button>
                  </>
                ) : null}
                <button className="secondary" onClick={() => void remove(entry)}>
                  Remove episode
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      <h3>
        Season packs ({packs.length} season pack offer{packs.length === 1 ? "" : "s"})
      </h3>
      {packs.length === 0 ? (
        <p>No season pack offers.</p>
      ) : (
        <div className="cards">
          {packs.some((pack) => hasCompetingCollection(packs, pack)) ? (
            <p>
              Choose one {packs.find((pack) => hasCompetingCollection(packs, pack))?.seriesTitle} collection for Season {packs.find((pack) => hasCompetingCollection(packs, pack))?.season}. Only that season will be imported.
            </p>
          ) : null}
          {packs.map((pack) => (
            <article key={pack.id}>
              <h4>
                {pack.seriesTitle ?? "Unknown series"}
                {pack.season !== null ? ` Season ${pack.season}` : null}
              </h4>
              <p>{pack.message}</p>
              <p>
                {pack.episodeCount !== null
                  ? `${pack.episodeCount} episode(s)`
                  : "Unknown episode count"}
                {pack.totalBytes !== null
                  ? ` · ${formatBytes(pack.totalBytes)}`
                  : null}
                {pack.provider ? ` · ${pack.provider}` : null}
              </p>
              <ul>
                {pack.episodes.map((item, index) => (
                  <li key={`${pack.id}-${index}`}>
                    Episode {item.episode !== null ? item.episode : "unknown"}
                    {item.resolution ? ` · ${item.resolution}` : null}
                    {item.sizeBytes !== null ? ` · ${formatBytes(item.sizeBytes)}` : null}
                    {" · "}
                    <AcquisitionStatus state={item.status} />
                  </li>
                ))}
              </ul>
              <button onClick={() => void importSeason(pack.id)}>
                {pack.season !== null ? `Import Season ${pack.season}` : "Import season"}
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
