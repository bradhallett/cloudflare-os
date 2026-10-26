import { useCallback, useEffect, useState } from "react";
import type { ComposioAppUiClient, TriggersData } from "./types";

type Props = {
  ui: ComposioAppUiClient;
};

export default function TriggersSection({ ui }: Props) {
  const [data, setData] = useState<TriggersData>();
  const [error, setError] = useState<string>();
  const [rotating, setRotating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [triggers, notices, webhooks] = await Promise.all([
        ui.listTriggers(),
        ui.expiryNotices(),
        ui.webhookState(),
      ]);
      setError(undefined);
      setData({ triggers, notices, webhooks });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [ui]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rotate = useCallback(async () => {
    setRotating(true);
    try {
      await ui.rotateWebhookSecret();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRotating(false);
    }
  }, [ui, refresh]);

  return (
    <section className="mt-10" aria-labelledby="triggers-heading">
      <h2
        id="triggers-heading"
        className="text-xs font-medium uppercase tracking-[0.12em] text-kumo-inactive"
      >
        Triggers
      </h2>
      {error && (
        <p role="alert" className="mt-3 text-sm text-kumo-danger">
          {error}
        </p>
      )}
      {data && (
        <>
          <p className="mt-3 text-sm text-kumo-default">
            {data.triggers.length === 0
              ? "No armed triggers."
              : `${data.triggers.length} armed trigger${data.triggers.length === 1 ? "" : "s"}:`}
          </p>
          {data.triggers.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm text-kumo-default">
              {data.triggers.map(trigger => (
                <li key={trigger.triggerId}>
                  <strong>{trigger.triggerSlug}</strong>
                  <span className="text-kumo-subtle">
                    {" "}
                    — workspace {trigger.workspaceId}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {data.notices.length > 0 && (
            <div className="mt-3">
              <p className="text-sm text-kumo-default">
                Upstream reported {data.notices.length} connected account
                {data.notices.length === 1 ? "" : "s"} expired — reconnect{" "}
                {data.notices.map(notice => notice.toolkitSlug).join(", ")} to resume their tools.
              </p>
            </div>
          )}
          <p className="mt-3 text-sm text-kumo-default">
            Webhook subscription:{" "}
            {data.webhooks.subscribed && data.webhooks.url ? (
              <>
                active at <code className="text-xs">{data.webhooks.url}</code>
              </>
            ) : (
              "not registered yet — arms when the first trigger is enabled"
            )}
            .
          </p>
          <button
            type="button"
            onClick={() => void rotate()}
            disabled={rotating}
            className="mt-3 rounded-md border border-kumo-line px-3 py-1.5 text-sm text-kumo-default disabled:opacity-50"
          >
            {rotating ? "Rotating…" : "Rotate webhook secret"}
          </button>
        </>
      )}
    </section>
  );
}
