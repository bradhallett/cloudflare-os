import type { QuotaCounters, Usage } from "./types";

type Props = {
  usage?: Usage;
};

function countersLine(counters: QuotaCounters): string {
  const parts = [`${counters.settled} completed`];
  if (counters.reserved > 0) parts.push(`${counters.reserved} in flight`);
  if (counters.refused > 0) parts.push(`${counters.refused} refused`);
  return parts.join(", ");
}

export default function UsageSection({ usage }: Props) {
  if (!usage) return null;
  return (
    <section className="mt-10" aria-labelledby="usage-heading">
      <h2
        id="usage-heading"
        className="text-xs font-medium uppercase tracking-[0.12em] text-kumo-inactive"
      >
        Usage today
      </h2>
      <p className="mt-3 text-sm text-kumo-default">
        Deployment key: <strong>{usage.deployment.settled}</strong> of {usage.limit} calls today
        <span className="text-kumo-subtle"> ({countersLine(usage.deployment)})</span>. Calls are
        capped per user per UTC day.
      </p>
      <p className="mt-1 text-sm text-kumo-default">
        Own key: <strong>{usage.own.settled}</strong> calls today
        <span className="text-kumo-subtle"> ({countersLine(usage.own)})</span>. Own-key calls spend
        your project’s quota and are never refused at the deployment limit.
      </p>
      <p className="mt-1 text-sm text-kumo-default">
        Trigger events: <strong>{usage.events.delivered}</strong> delivered today
        {usage.events.dropped > 0 && (
          <>
            , <strong>{usage.events.dropped}</strong> dropped over the limit
          </>
        )}{" "}
        — capped at {usage.events.limit} per workspace per UTC day.
      </p>
    </section>
  );
}
