import { useEffect, useState } from "react";
import { markTvApi, type MarkTvApi } from "../api";
import type { ApiError, MediaItem, MediaRoot, Pool } from "../types";
import { PoolEditor } from "../components/PoolEditor";

export function Library({ client = markTvApi }: { client?: MarkTvApi }) {
  const [roots, setRoots] = useState<MediaRoot[]>([]);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [pools, setPools] = useState<Pool[]>([]);
  const [drafts, setDrafts] = useState<Record<string, MediaItem>>({});
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [rootPath, setRootPath] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    Promise.all([
      client.listMediaRoots(),
      client.listMedia(),
      client.listPools(),
    ])
      .then(([loadedRoots, loadedItems, loadedPools]) => {
        setRoots(loadedRoots);
        setItems(loadedItems);
        setPools(loadedPools);
      })
      .catch(() => setError("Library data is unavailable."));
  }, [client]);

  const addRoot = async () => {
    try {
      const root = await client.addMediaRoot(rootPath);
      setRoots((current) => [
        ...current.filter((entry) => entry.id !== root.id),
        root,
      ]);
      setRootPath("");
    } catch (caught) {
      setError((caught as ApiError).message);
    }
  };
  const scan = async (root: MediaRoot) => {
    try {
      const result = await client.scanMediaRoot(root.id);
      setRoots((current) =>
        current.map((entry) => (entry.id === root.id ? result.root : entry)),
      );
      setItems((current) => [
        ...current.filter(
          (entry) =>
            !result.result.items.some((found) => found.id === entry.id),
        ),
        ...result.result.items,
      ]);
    } catch (caught) {
      setError((caught as ApiError).message);
    }
  };
  const remove = async (root: MediaRoot) => {
    await client.removeMediaRoot(root.id);
    setRoots((current) => current.filter((entry) => entry.id !== root.id));
  };
  const draft = (item: MediaItem) => drafts[item.id] ?? item;
  const change = (item: MediaItem, patch: Partial<MediaItem>) =>
    setDrafts((current) => ({
      ...current,
      [item.id]: { ...draft(item), ...patch },
    }));
  const save = async (item: MediaItem) => {
    const edited = draft(item);
    await client.updateMedia(edited);
    const poolId = assignments[item.id];
    const pool = pools.find((candidate) => candidate.id === poolId);
    if (pool && !pool.mediaIds.includes(item.id)) {
      const updated = { ...pool, mediaIds: [...pool.mediaIds, item.id] };
      await client.updatePool(updated);
      setPools((current) =>
        current.map((candidate) =>
          candidate.id === updated.id ? updated : candidate,
        ),
      );
    }
    setItems((current) =>
      current.map((candidate) =>
        candidate.id === item.id ? edited : candidate,
      ),
    );
  };

  return (
    <section>
      <h2>Library</h2>
      <p>
        Local folders are scanned read-only. Missing durations stay unavailable
        until repaired.
      </p>
      <div className="toolbar">
        <label>
          Local media folder
          <input
            value={rootPath}
            placeholder="/absolute/path/to/media"
            onChange={(event) => setRootPath(event.target.value)}
          />
        </label>
        <button disabled={!rootPath} onClick={addRoot}>
          Add folder
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <div className="root-list">
        {roots.map((root) => (
          <article key={root.id}>
            <h3>{root.path}</h3>
            <p>
              {root.lastScannedAt
                ? `Last scanned ${root.lastScannedAt}`
                : "Not scanned yet"}
            </p>
            <button onClick={() => scan(root)}>Scan folder</button>
            <button className="secondary" onClick={() => remove(root)}>
              Remove folder
            </button>
            {root.diagnostics.map((diagnostic, index) => (
              <p className="warning" key={`${diagnostic.code}-${index}`}>
                {diagnostic.message}
              </p>
            ))}
          </article>
        ))}
      </div>
      <PoolEditor client={client} pools={pools} onChange={setPools} />
      <h3>Media metadata and pool assignment</h3>
      {items.length ? (
        <div className="media-list">
          {items.map((item) => {
            const edited = draft(item);
            return (
              <article key={item.id}>
                <p className="eyebrow">
                  {item.kind} · {item.durationStatus}
                </p>
                <label>
                  Title for {item.title}
                  <input
                    value={edited.title}
                    onChange={(event) =>
                      change(item, { title: event.target.value })
                    }
                  />
                </label>
                <label>
                  Kind for {item.title}
                  <select
                    value={edited.kind}
                    onChange={(event) =>
                      change(item, {
                        kind: event.target.value as MediaItem["kind"],
                      })
                    }
                  >
                    {[
                      "episode",
                      "movie",
                      "commercial",
                      "filler",
                      "station-id",
                      "bumper",
                    ].map((kind) => (
                      <option value={kind} key={kind}>
                        {kind}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Duration milliseconds for {item.title}
                  <input
                    type="number"
                    value={edited.durationMs ?? ""}
                    onChange={(event) => {
                      const durationMs = Number(event.target.value) || null;
                      change(item, {
                        durationMs,
                        durationStatus: durationMs ? "ok" : "missing",
                        available: Boolean(durationMs),
                      });
                    }}
                  />
                </label>
                <label>
                  Pool for {item.title}
                  <select
                    value={assignments[item.id] ?? ""}
                    onChange={(event) =>
                      setAssignments((current) => ({
                        ...current,
                        [item.id]: event.target.value,
                      }))
                    }
                  >
                    <option value="">Unassigned</option>
                    {pools
                      .filter((pool) => pool.kinds.includes(item.kind))
                      .map((pool) => (
                        <option value={pool.id} key={pool.id}>
                          {pool.name}
                        </option>
                      ))}
                  </select>
                </label>
                <button onClick={() => save(item)}>Save {item.title}</button>
              </article>
            );
          })}
        </div>
      ) : (
        <p>No media has been discovered.</p>
      )}
    </section>
  );
}
