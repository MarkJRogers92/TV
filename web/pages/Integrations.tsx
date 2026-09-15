import { useEffect, useState } from "react";
import { markTvApi, type MarkTvApi } from "../api";
import type { ApiError, IntegrationProjection, IntegrationProvider } from "../types";

const providers: Array<{ id: IntegrationProvider; label: string }> = [
  { id: "real-debrid", label: "Real-Debrid" },
  { id: "torbox", label: "TorBox" },
];

export function Integrations({ client = markTvApi }: { client?: MarkTvApi }) {
  const [statuses, setStatuses] = useState<IntegrationProjection[]>([]);
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    client
      .listIntegrations()
      .then(setStatuses)
      .catch(() => setLoadError("Integration data is unavailable."));
  }, [client]);

  const statusFor = (provider: IntegrationProvider): IntegrationProjection =>
    statuses.find((entry) => entry.provider === provider) ?? {
      provider,
      connected: false,
      accountLabel: null,
      error: null,
    };

  const save = async (provider: IntegrationProvider) => {
    setActionError("");
    setNotice("");
    const token = (tokens[provider] ?? "").trim();
    if (!token) {
      setActionError("Enter a token before saving.");
      return;
    }
    setBusy(`${provider}:save`);
    try {
      const updated = await client.saveIntegrationToken(provider, token);
      setStatuses((current) => [
        ...current.filter((entry) => entry.provider !== provider),
        updated,
      ]);
      setTokens((current) => ({ ...current, [provider]: "" }));
      setNotice(`Token saved for ${provider}. Test the connection next.`);
    } catch (caught) {
      setActionError((caught as ApiError).message);
    } finally {
      setBusy("");
    }
  };

  const test = async (provider: IntegrationProvider) => {
    setActionError("");
    setNotice("");
    setBusy(`${provider}:test`);
    try {
      const updated = await client.testIntegration(provider);
      setStatuses((current) => [
        ...current.filter((entry) => entry.provider !== provider),
        updated,
      ]);
      setNotice(
        updated.connected
          ? `Connected to ${provider}.`
          : `Connection test finished for ${provider}.`,
      );
    } catch (caught) {
      setActionError((caught as ApiError).message);
    } finally {
      setBusy("");
    }
  };

  return (
    <section>
      <h2>Integrations</h2>
      <p>Save a provider token, then test the connection. Tokens are never shown again.</p>
      {loadError ? <p role="alert">{loadError}</p> : null}
      {actionError ? <p role="alert">{actionError}</p> : null}
      {notice ? <p className="success">{notice}</p> : null}
      <div className="cards">
        {providers.map(({ id, label }) => {
          const status = statusFor(id);
          return (
            <article key={id}>
              <h3>{label}</h3>
              <p>{status.connected ? "Connected" : "Not connected"}</p>
              {status.accountLabel ? <p>Account: {status.accountLabel}</p> : null}
              {status.error ? <p role="alert">{status.error.message}</p> : null}
              <label>
                Token for {id}
                <input
                  type="password"
                  aria-label={`Token for ${id}`}
                  autoComplete="off"
                  value={tokens[id] ?? ""}
                  onChange={(event) =>
                    setTokens((current) => ({
                      ...current,
                      [id]: event.target.value,
                    }))
                  }
                />
              </label>
              <button
                disabled={busy === `${id}:save`}
                onClick={() => void save(id)}
              >
                Save token
              </button>
              <button
                className="secondary"
                disabled={busy === `${id}:test`}
                onClick={() => void test(id)}
              >
                Test connection
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
