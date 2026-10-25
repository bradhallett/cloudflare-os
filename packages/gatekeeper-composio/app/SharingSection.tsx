import { WarningCircle } from "@phosphor-icons/react";
import { useState } from "react";
import type { ComposioAppUiClient } from "./types";

type Props = {
  ui: ComposioAppUiClient;
  enabled?: boolean;
  onSharingChanged: () => Promise<void>;
};

export default function SharingSection({ ui, enabled, onSharingChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const toggleSharing = async (on: boolean) => {
    setError(undefined);
    setBusy(true);
    try {
      await ui.setSharing(on);
      await onSharingChanged();
    } catch (caught) {
      // The account DO refuses to enable sharing while auto-apply is armed (and vice versa);
      // surface that refusal instead of pretending the toggle moved.
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const on = enabled === true;

  return (
    <section className="mt-10" aria-labelledby="sharing-heading">
      <h2
        id="sharing-heading"
        className="text-xs font-medium uppercase tracking-[0.12em] text-kumo-inactive"
      >
        Sharing with collaborators
      </h2>
      <div
        className={`mt-3 rounded-xl border p-4 ${
          on ? "border-kumo-danger/40 bg-kumo-danger-tint" : "border-kumo-line bg-kumo-elevated"
        }`}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-kumo-default">
              {on ? "Sharing is on" : enabled === false ? "Sharing is off" : "Sharing state unavailable"}
            </p>
            <p className={`mt-1 text-xs ${on ? "text-kumo-danger" : "text-kumo-subtle"}`}>
              {on
                ? "Collaborators currently observe everything this account reads, can approve and continue its queued actions, and their chats can read through it — in every shared workspace, every toolkit, both key modes."
                : "While off, shared workspaces that rely on this account cannot be opened by collaborators."}
            </p>
          </div>
          {enabled !== undefined && (
            <button
              type="button"
              role="switch"
              aria-checked={on}
              aria-labelledby="sharing-heading"
              disabled={busy}
              className={`press relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                on ? "bg-kumo-danger" : "bg-kumo-fill"
              } disabled:opacity-50`}
              onClick={() => void toggleSharing(!on)}
            >
              <span className="sr-only">
                {busy ? "Updating sharing…" : on ? "Turn sharing off" : "Turn sharing on"}
              </span>
              <span
                className={`inline-block h-4.5 w-4.5 transform rounded-full bg-white transition-transform ${
                  on ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          )}
        </div>

        <div className="mt-3 rounded-lg border border-kumo-line bg-kumo-control p-3 text-xs text-kumo-subtle">
          <p className="font-medium text-kumo-default">Turning sharing on grants, in full:</p>
          <ul className="mt-2 list-disc pl-5">
            <li>
              Collaborators observe everything this account reads — in every shared workspace,
              every toolkit, both key modes.
            </li>
            <li>Collaborators can approve and continue this account’s queued actions.</li>
            <li>Collaborators’ own chats can read through this account.</li>
          </ul>
          <p className="mt-2 flex items-start gap-1.5">
            <WarningCircle size={14} className="mt-0.5 shrink-0 text-kumo-danger" />
            Arming toolkit auto-apply is refused while sharing is on. Consent is all-or-nothing —
            there is no per-workspace or per-toolkit sharing.
          </p>
        </div>

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
