import { useCallback, useEffect, useState } from "react";
import type { MarkTvApi } from "../api";
import type { ApiError, MovieProgrammingStatus } from "../types";

/** How many upcoming airings the panel lists before it stops being readable. */
const UPCOMING_LIMIT = 14;

/**
 * Pool an enabling channel enrols its movie library into.
 *
 * A name rather than an id from the server: the operator turning the feature on
 * is choosing where the films go, and the enrolment sweep creates the pool on the
 * first enable if it does not exist yet.
 */
const DEFAULT_MOVIE_POOL = "movies";

/**
 * The movie-programming control and preview.
 *
 * Reads the same status the scheduler uses, so what is shown here is what
 * generation will do - the folder, how many movies the rotation holds, the next
 * airings, and anything degraded. The toggle writes the single configuration
 * flag; everything else about the feature (anchors, pools, lookahead) stays in
 * the channel document.
 */
export function MovieProgrammingPanel({
  client,
  channelId = "marktv-laughs",
}: {
  client?: MarkTvApi;
  channelId?: string;
}) {
  const [status, setStatus] = useState<MovieProgrammingStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Enabling writes a complete configuration, never just the flag: an enabled
  // feature with no pool and no folder is a channel that says it has movie
  // programming and can never schedule a film.
  const [poolId, setPoolId] = useState(DEFAULT_MOVIE_POOL);
  const [rootPath, setRootPath] = useState("");
  // Several pages and tests inject a narrow client with only the methods they
  // exercise. Rendering nothing is the honest answer there, and keeps a page that
  // has nothing to do with movies usable.
  const supported = typeof client?.movieProgrammingStatus === "function";

  const load = useCallback(async () => {
    if (!supported) return;
    try {
      setStatus(await client!.movieProgrammingStatus(channelId));
      setError("");
    } catch {
      setError("Could not load movie programming.");
    }
  }, [client, channelId, supported]);

  useEffect(() => {
    void load();
  }, [load]);

  // Offer the folders this install already scans, so enabling does not require
  // typing a path that is already registered. A client narrow enough to have no
  // root listing simply leaves the field to the operator.
  useEffect(() => {
    if (typeof client?.listMediaRoots !== "function") return;
    let cancelled = false;
    void (async () => {
      try {
        const roots = await client!.listMediaRoots();
        if (!cancelled && roots.length)
          setRootPath((current) => current || roots[0].path);
      } catch {
        // Typing the folder by hand is the fallback, and the server validates it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    if (status?.rootPath) setRootPath((current) => current || status.rootPath!);
  }, [status]);

  if (!supported) return null;

  const toggle = async () => {
    const next = !(status?.enabled ?? false);
    if (next && (!poolId.trim() || !rootPath.trim())) {
      setError(
        "Movie programming needs the pool its films are enrolled into and the folder they are scanned from.",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      await client!.setMovieProgramming(
        channelId,
        next
          ? { enabled: true, poolIds: [poolId.trim()], rootPath: rootPath.trim() }
          : { enabled: false },
      );
      await load();
    } catch (caught) {
      const apiError = caught as ApiError;
      setError(
        apiError.issues
          ?.map((issue) => `${issue.path}: ${issue.message}`)
          .join("; ") || apiError.message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="movie-programming-heading">
      <h3 id="movie-programming-heading">Movie programming</h3>
      {error ? <p role="alert">{error}</p> : null}
      {!status ? (
        <p>Loading movie programming…</p>
      ) : (
        <>
          <p className="status-line">
            Feature: <strong>{status.enabled ? "On" : "Off"}</strong>
          </p>
          <div className="toolbar">
            {!status.enabled ? (
              <>
                <label>
                  Movie pool
                  <input
                    value={poolId}
                    onChange={(event) => setPoolId(event.target.value)}
                    disabled={busy}
                  />
                </label>
                <label>
                  Movie folder
                  <input
                    value={rootPath}
                    onChange={(event) => setRootPath(event.target.value)}
                    placeholder="/Volumes/Media/Movies"
                    disabled={busy}
                  />
                </label>
              </>
            ) : null}
            <button onClick={toggle} disabled={busy}>
              {status.enabled
                ? "Turn movie programming off"
                : "Turn movie programming on"}
            </button>
          </div>
          {status.enabled ? (
            <>
              <ul className="status-line">
                <li>
                  Movie folder: {status.rootPath ?? "not configured"} (
                  {status.rootAvailable ? "reachable" : "unreachable"})
                </li>
                <li>
                  Rotation: {status.movieCount ?? 0} movie
                  {(status.movieCount ?? 0) === 1 ? "" : "s"}
                </li>
                <li>Preview horizon: {status.lookaheadDays ?? 0} days</li>
              </ul>
              {status.degraded.length ? (
                <ul className="warning">
                  {status.degraded.map((message, index) => (
                    <li key={`${index}-${message}`}>{message}</li>
                  ))}
                </ul>
              ) : null}
              <h4>Upcoming movies</h4>
              {status.upcoming.length ? (
                <ul>
                  {status.upcoming.slice(0, UPCOMING_LIMIT).map((airing) => (
                    <li key={`${airing.date}-${airing.position}`}>
                      {airing.date} {airing.anchor} · {airing.role} ·{" "}
                      {airing.title}
                      {airing.encore ? " (encore)" : ""}
                      {airing.available ? "" : " (unavailable)"}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No movie airings are assigned yet.</p>
              )}
            </>
          ) : (
            <p>
              Nightly and weekend films are not scheduled. Turn the feature on
              to add them to this channel.
            </p>
          )}
        </>
      )}
    </section>
  );
}
