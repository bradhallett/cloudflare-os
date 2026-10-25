import { ShieldWarning } from "@phosphor-icons/react";

export default function DisclosureSection() {
  return (
    <section className="mt-10" aria-labelledby="data-heading">
      <h2
        id="data-heading"
        className="text-xs font-medium uppercase tracking-[0.12em] text-kumo-inactive"
      >
        How your data travels
      </h2>
      <div className="mt-3 flex gap-3 rounded-xl border border-kumo-line bg-kumo-elevated p-4">
        <ShieldWarning size={18} className="mt-0.5 shrink-0 text-kumo-subtle" />
        <ul className="list-disc space-y-1.5 pl-1 text-xs text-kumo-subtle">
          <li>
            Tokens for the apps you connect live at Composio, not here — this connector holds only
            the Composio project key.
          </li>
          <li>
            Tool payloads (arguments and responses) are retained by Composio for up to one year by
            default.
          </li>
          <li>
            Zero-data-retention stops storing payloads for new covered calls but leaves earlier
            logs untouched and excludes triggers; managed apps are Enterprise-only. Restricted-data
            workspaces should require ZDR and know triggers stay outside it.
          </li>
          <li>
            Removing and re-adding this connector provisions a fresh account: the previous Composio
            user cannot be deleted (Composio has no user-delete API) and is orphaned.
          </li>
        </ul>
      </div>
    </section>
  );
}
