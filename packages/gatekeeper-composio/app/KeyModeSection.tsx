import { Key, WarningCircle, XCircle } from "@phosphor-icons/react";
import { useState } from "react";
import type { ComposioAppUiClient, KeyMode } from "./types";

// Composio scoped-key permissions are fixed at key creation, and tool execution is separate from
// session management — the paste-own-key flow must tell the user the full six-area list up front.
const REQUIRED_KEY_PERMISSIONS = [
  "Session management (read/write)",
  "Session tool execution (write)",
  "Toolkits (read)",
  "Connected accounts (read/write)",
  "Triggers (read/write)",
  "Webhooks (read/write)",
];

type Props = {
  ui: ComposioAppUiClient;
  keyMode?: KeyMode;
  onKeyModeChanged: () => Promise<void>;
};

export default function KeyModeSection({ ui, keyMode, onKeyModeChanged }: Props) {
  const [showPaste, setShowPaste] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submitOwnKey = async () => {
    const key = keyDraft.trim();
    if (!key) return;
    setError(undefined);
    setBusy(true);
    try {
      await ui.setOwnKey(key);
      setKeyDraft("");
      setShowPaste(false);
      await onKeyModeChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const clearOwnKey = async () => {
    setError(undefined);
    setBusy(true);
    try {
      await ui.clearOwnKey();
      await onKeyModeChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-10" aria-labelledby="key-mode-heading">
      <h2
        id="key-mode-heading"
        className="text-xs font-medium uppercase tracking-[0.12em] text-kumo-inactive"
      >
        API key
      </h2>
      <div className="mt-3 rounded-xl border border-kumo-line bg-kumo-elevated p-4">
        <p className="flex items-center gap-2 text-sm text-kumo-default">
          <Key size={15} className="text-kumo-subtle" />
          {keyMode === "own" ? (
            <>
              Using <strong>your own Composio project key</strong>. Tool calls spend your
              project’s quota, and connected accounts live in your project.
            </>
          ) : keyMode === "deployment" ? (
            <>
              Using the <strong>deployment’s Composio project key</strong>. Tool calls spend a
              per-user daily quota of the deployment’s project.
            </>
          ) : (
            <>Key mode unavailable right now.</>
          )}
        </p>

        {keyMode === "own" ? (
          <button
            type="button"
            disabled={busy}
            className="press mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg border border-kumo-line bg-kumo-control px-3 text-sm font-medium text-kumo-danger hover:bg-kumo-tint disabled:opacity-50"
            onClick={() => void clearOwnKey()}
          >
            <XCircle size={14} />
            {busy ? "Clearing…" : "Clear key and return to the deployment key"}
          </button>
        ) : (
          <button
            type="button"
            className="press mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg border border-kumo-line bg-kumo-control px-3 text-sm font-medium text-kumo-default hover:bg-kumo-tint"
            aria-expanded={showPaste}
            onClick={() => setShowPaste(!showPaste)}
          >
            Use my own Composio key
          </button>
        )}

        {showPaste && keyMode !== "own" && (
          <form
            className="mt-4 flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submitOwnKey();
            }}
          >
            <div className="rounded-lg border border-kumo-line bg-kumo-control p-3 text-xs text-kumo-subtle">
              <p className="font-medium text-kumo-default">
                Create a scoped key with these six permission areas — Composio fixes them when the
                key is made, and tool execution is separate from session management:
              </p>
              <ul className="mt-2 list-disc pl-5">
                {REQUIRED_KEY_PERMISSIONS.map((permission) => (
                  <li key={permission}>{permission}</li>
                ))}
              </ul>
            </div>
            <label className="flex flex-col gap-1.5 text-sm text-kumo-subtle">
              Composio project API key
              <input
                className="h-9 rounded-lg border border-kumo-line bg-kumo-control px-3 text-sm text-kumo-default outline-none focus:ring-2 focus:ring-kumo-ring"
                type="password"
                autoComplete="off"
                maxLength={500}
                placeholder="Paste your key"
                value={keyDraft}
                onChange={(event) => setKeyDraft(event.currentTarget.value)}
              />
            </label>
            <p className="text-xs text-kumo-subtle">
              The key is validated live before it’s committed. Switching keys is refused while
              queued actions are pending, so nothing approved under one project runs in another.
            </p>
            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={busy || !keyDraft.trim()}
                className="press inline-flex h-8 items-center rounded-lg bg-kumo-brand px-3.5 text-sm font-medium text-white hover:bg-kumo-brand-hover disabled:opacity-50"
              >
                {busy ? "Validating…" : "Save key"}
              </button>
              <button
                type="button"
                className="text-sm font-medium text-kumo-subtle hover:text-kumo-default"
                onClick={() => {
                  setShowPaste(false);
                  setKeyDraft("");
                  setError(undefined);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {error && (
          <p role="alert" className="mt-3 flex items-start gap-2 text-sm text-kumo-danger">
            <WarningCircle size={16} className="mt-0.5 shrink-0" />
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
