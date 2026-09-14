import { useState } from "react";
import type { MarkTvApi } from "../api";
import type { ApiError, MediaItem, Pool } from "../types";

const kinds: MediaItem["kind"][] = [
  "episode",
  "movie",
  "commercial",
  "filler",
  "station-id",
  "bumper",
];
const numberValue = (value: string) => Number(value) || 0;
const issueText = (caught: unknown) => {
  const error = caught as ApiError;
  return error.issues?.length
    ? error.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")
    : error.message || "Pool update failed";
};

export function PoolEditor({
  client,
  pools,
  onChange,
}: {
  client: MarkTvApi;
  pools: Pool[];
  onChange: (pools: Pool[]) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, Pool>>({});
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");
  const draft = (pool: Pool) => drafts[pool.id] ?? pool;
  const change = (pool: Pool, patch: Partial<Pool>) =>
    setDrafts((current) => ({
      ...current,
      [pool.id]: { ...draft(pool), ...patch },
    }));

  const create = async () => {
    setError("");
    try {
      const created = await client.createPool({
        id: newId,
        name: newName,
        kinds: ["episode"],
        mediaIds: [],
        mode: "chronological",
        noRepeatMinutes: 0,
        weight: 1,
      });
      onChange([...pools, created]);
      setNewId("");
      setNewName("");
    } catch (caught) {
      setError(issueText(caught));
    }
  };
  const save = async (pool: Pool) => {
    setError("");
    try {
      const updated = await client.updatePool(draft(pool));
      onChange(
        pools.map((candidate) =>
          candidate.id === updated.id ? updated : candidate,
        ),
      );
      setDrafts((current) => {
        const next = { ...current };
        delete next[pool.id];
        return next;
      });
    } catch (caught) {
      setError(issueText(caught));
    }
  };
  const remove = async (pool: Pool) => {
    setError("");
    try {
      await client.removePool(pool.id);
      onChange(pools.filter((candidate) => candidate.id !== pool.id));
    } catch (caught) {
      setError(issueText(caught));
    }
  };

  return (
    <section>
      <h3>Programming pools</h3>
      <div className="toolbar">
        <label>
          New pool ID
          <input
            value={newId}
            onChange={(event) => setNewId(event.target.value)}
          />
        </label>
        <label>
          New pool name
          <input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
          />
        </label>
        <button disabled={!newId || !newName} onClick={create}>
          Create pool
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <div className="pool-list">
        {pools.map((pool) => {
          const edited = draft(pool);
          return (
            <article key={pool.id}>
              <h4>{pool.id}</h4>
              <div className="form-grid">
                <label>
                  Pool name for {pool.id}
                  <input
                    value={edited.name}
                    onChange={(event) =>
                      change(pool, { name: event.target.value })
                    }
                  />
                </label>
                <label>
                  Selection mode for {pool.id}
                  <select
                    value={edited.mode}
                    onChange={(event) =>
                      change(pool, { mode: event.target.value as Pool["mode"] })
                    }
                  >
                    <option value="chronological">chronological</option>
                    <option value="shuffle">shuffle</option>
                  </select>
                </label>
                <label>
                  No-repeat minutes for {pool.id}
                  <input
                    type="number"
                    value={edited.noRepeatMinutes}
                    onChange={(event) =>
                      change(pool, {
                        noRepeatMinutes: numberValue(event.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Weight for {pool.id}
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={edited.weight}
                    onChange={(event) =>
                      change(pool, { weight: numberValue(event.target.value) })
                    }
                  />
                </label>
                <label>
                  Media IDs for {pool.id}
                  <input
                    value={edited.mediaIds.join(",")}
                    onChange={(event) =>
                      change(pool, {
                        mediaIds: event.target.value
                          .split(",")
                          .map((id) => id.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </label>
              </div>
              <fieldset>
                <legend>Allowed kinds for {pool.id}</legend>
                {kinds.map((kind) => (
                  <label key={kind}>
                    <input
                      type="checkbox"
                      checked={edited.kinds.includes(kind)}
                      onChange={(event) =>
                        change(pool, {
                          kinds: event.target.checked
                            ? [...edited.kinds, kind]
                            : edited.kinds.filter((entry) => entry !== kind),
                        })
                      }
                    />{" "}
                    {kind} allowed in {pool.id}
                  </label>
                ))}
              </fieldset>
              <button onClick={() => save(pool)}>Save pool {pool.id}</button>
              <button className="secondary" onClick={() => remove(pool)}>
                Delete pool {pool.id}
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
