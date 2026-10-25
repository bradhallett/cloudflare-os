import {
  LinkBreak,
  MagnifyingGlass,
  PlugsConnected,
  SpinnerGap,
  WarningCircle,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { CatalogEntry, ComposioAppUiClient, ConnectedAccountInfo } from "./types";

// Connect links complete at Composio's own pace; poll gently and give the user a way out.
const POLL_INTERVAL_MS = 2_500;
const POLL_TIMEOUT_MS = 5 * 60_000;

type ConnectState = {
  slug: string;
  connectedAccountId: string;
  startedAt: number;
};

type Props = {
  ui: ComposioAppUiClient;
  query: string;
  onQueryChange: (query: string) => void;
  result: { entries: CatalogEntry[]; connected: ConnectedAccountInfo[] } | null;
  searching: boolean;
  error?: string;
  onRetrySearch: () => void;
  onConnectedChanged: () => void;
};

export default function CatalogSection({
  ui,
  query,
  onQueryChange,
  result,
  searching,
  error,
  onRetrySearch,
  onConnectedChanged,
}: Props) {
  const [aliasDrafts, setAliasDrafts] = useState<Record<string, string>>({});
  const [connect, setConnect] = useState<ConnectState | null>(null);
  const [connectError, setConnectError] = useState<string>();
  const [busyAccount, setBusyAccount] = useState<string>();
  const pollEpoch = useRef(0);

  // Poll the attempt's own connected-account id until it reports a terminal status. Never trust
  // the redirect URL for completion.
  useEffect(() => {
    if (!connect) return;
    const epoch = ++pollEpoch.current;
    const startedAt = connect.startedAt;
    const connectedAccountId = connect.connectedAccountId;
    const tick = async () => {
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        if (epoch === pollEpoch.current) {
          setConnectError(`Connecting ${connect.slug} timed out waiting for Composio.`);
          setConnect(null);
        }
        return;
      }
      try {
        const poll = await ui.pollConnectAttempt(connectedAccountId);
        if (epoch !== pollEpoch.current) return;
        if (!poll) return; // attempt not visible yet, keep polling
        if (poll.status === "ACTIVE") {
          setConnect(null);
          onConnectedChanged();
          return;
        }
        if (poll.status === "EXPIRED" || poll.status === "FAILED" || poll.status === "ERROR") {
          setConnectError(
            `Connecting ${connect.slug} did not complete (status: ${poll.status}). Try again.`,
          );
          setConnect(null);
          onConnectedChanged();
        }
      } catch (caught) {
        if (epoch === pollEpoch.current)
          setConnectError(caught instanceof Error ? caught.message : String(caught));
      }
    };
    void tick();
    const interval = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
      pollEpoch.current++;
    };
  }, [connect, ui, onConnectedChanged]);

  const startConnect = async (entry: CatalogEntry) => {
    const alias = aliasDrafts[entry.slug]?.trim() || undefined;
    setConnectError(undefined);
    setBusyAccount(entry.slug);
    try {
      const attempt = await ui.connectToolkit(entry.slug, alias);
      window.open(attempt.redirectUrl, "_blank", "noopener");
      setConnect({ slug: entry.slug, connectedAccountId: attempt.connectedAccountId, startedAt: Date.now() });
    } catch (caught) {
      setConnectError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyAccount(undefined);
    }
  };

  const disconnect = async (account: ConnectedAccountInfo) => {
    setConnectError(undefined);
    setBusyAccount(account.id);
    try {
      await ui.disconnectToolkit(account.id);
      onConnectedChanged();
    } catch (caught) {
      setConnectError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyAccount(undefined);
    }
  };

  const connectedBySlug = new Map<string, ConnectedAccountInfo[]>();
  for (const account of result?.connected ?? []) {
    const list = connectedBySlug.get(account.toolkitSlug) ?? [];
    list.push(account);
    connectedBySlug.set(account.toolkitSlug, list);
  }

  return (
    <section className="mt-10" aria-labelledby="catalog-heading">
      <h2
        id="catalog-heading"
        className="text-xs font-medium uppercase tracking-[0.12em] text-kumo-inactive"
      >
        Catalog
      </h2>
      <label className="mt-3 flex h-9 items-center gap-2 rounded-lg border border-kumo-line bg-kumo-control px-3 text-kumo-inactive focus-within:ring-2 focus-within:ring-kumo-ring">
        <MagnifyingGlass size={15} />
        <span className="sr-only">Search the Composio toolkit catalog</span>
        <input
          className="min-w-0 flex-1 bg-transparent text-sm text-kumo-default outline-none placeholder:text-kumo-inactive"
          type="search"
          value={query}
          maxLength={200}
          placeholder="Search toolkits…"
          onChange={(event) => onQueryChange(event.currentTarget.value)}
        />
      </label>

      <div aria-live="polite">
        {connectError && (
          <p role="alert" className="mt-3 flex items-start gap-2 text-sm text-kumo-danger">
            <WarningCircle size={16} className="mt-0.5 shrink-0" />
            {connectError}
          </p>
        )}
        {connect && (
          <p className="mt-3 flex items-center gap-2 text-sm text-kumo-subtle">
            <SpinnerGap size={16} className="animate-spin" />
            Waiting for you to finish connecting {connect.slug} in the opened tab…
            <button
              type="button"
              className="ml-1 font-medium text-kumo-link hover:text-kumo-brand-hover"
              onClick={() => setConnect(null)}
            >
              Cancel
            </button>
          </p>
        )}

        {searching && !result ? (
          <p className="py-10 text-center text-sm text-kumo-subtle">Loading the catalog…</p>
        ) : error ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <p className="text-sm text-kumo-danger">Couldn’t load the catalog.</p>
            <button
              type="button"
              className="text-sm font-medium text-kumo-link hover:text-kumo-brand-hover"
              onClick={onRetrySearch}
            >
              Try again
            </button>
          </div>
        ) : (result?.entries.length ?? 0) === 0 ? (
          <p className="py-10 text-center text-sm text-kumo-subtle">No toolkits match your search.</p>
        ) : (
          <ul className="divide-y divide-kumo-line">
            {(result?.entries ?? []).map((entry) => {
              const connected = connectedBySlug.get(entry.slug) ?? [];
              return (
                <li key={entry.slug} className="flex flex-col gap-2 py-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-kumo-default">
                        {entry.name}
                        {connected.some((account) => account.status === "ACTIVE") ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-kumo-tint px-2 py-0.5 text-xs font-normal text-kumo-subtle">
                            <PlugsConnected size={12} /> Connected
                          </span>
                        ) : null}
                        <span className="font-normal text-kumo-inactive">
                          {entry.toolCount} {entry.toolCount === 1 ? "tool" : "tools"}
                        </span>
                      </p>
                      {entry.description && (
                        <p className="mt-0.5 text-xs text-kumo-subtle">{entry.description}</p>
                      )}
                    </div>
                    <button
                      type="button"
                      disabled={busyAccount === entry.slug || connect !== null}
                      className="press inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-kumo-brand px-3 text-sm font-medium text-white hover:bg-kumo-brand-hover disabled:opacity-50"
                      onClick={() => void startConnect(entry)}
                    >
                      {busyAccount === entry.slug ? "Connecting…" : "Connect"}
                    </button>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-kumo-subtle">
                    <span className="sr-only">Account label for {entry.name}</span>
                    <input
                      className="h-8 w-56 rounded-lg border border-kumo-line bg-kumo-control px-2.5 text-sm text-kumo-default outline-none placeholder:text-kumo-inactive focus:ring-2 focus:ring-kumo-ring"
                      type="text"
                      maxLength={100}
                      placeholder="Account label (optional)"
                      value={aliasDrafts[entry.slug] ?? ""}
                      onChange={(event) =>
                        setAliasDrafts((current) => ({
                          ...current,
                          [entry.slug]: event.currentTarget.value,
                        }))
                      }
                    />
                    <span>Labels help when several accounts are connected.</span>
                  </label>
                  {connected.length > 0 && (
                    <ul className="flex flex-col gap-1.5" aria-label={`Connected ${entry.name} accounts`}>
                      {connected.map((account) => (
                        <li
                          key={account.id}
                          className="flex items-center justify-between gap-3 rounded-lg bg-kumo-elevated px-3 py-1.5 text-sm"
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-kumo-default">
                              {account.alias || account.id}
                            </span>
                            <span
                              className={
                                account.status === "ACTIVE"
                                  ? "text-xs text-kumo-subtle"
                                  : "inline-flex items-center gap-1 text-xs font-medium text-kumo-danger"
                              }
                            >
                              {account.status !== "ACTIVE" && <WarningCircle size={12} />}
                              {account.status === "ACTIVE" ? "Active" : account.status}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            {account.status !== "ACTIVE" && (
                              <button
                                type="button"
                                disabled={busyAccount === account.id || connect !== null}
                                className="text-xs font-medium text-kumo-link hover:text-kumo-brand-hover disabled:opacity-50"
                                onClick={() => void startConnect(entry)}
                              >
                                Reconnect
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={busyAccount === account.id}
                              className="inline-flex items-center gap-1 text-xs font-medium text-kumo-danger hover:opacity-80 disabled:opacity-50"
                              onClick={() => void disconnect(account)}
                            >
                              <LinkBreak size={12} />
                              {busyAccount === account.id ? "Disconnecting…" : "Disconnect"}
                            </button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
