// The read side of the `gadgets_metrics_v1` dataset: the canonical Workers Analytics Engine SQL
// for the questions the write side (`metrics.ts`) was designed to answer. Column names resolve
// from `metrics-schema.ts`, so a slot rename moves writer and queries together (pinned by
// `__tests__/metrics-queries.test.ts`).
//
// Run these against the Analytics Engine SQL API — POST the query text to
// `https://api.cloudflare.com/client/v4/accounts/<account_id>/analytics_engine/sql` with an
// Account Analytics Read bearer token — or paste one into a dashboard widget's SQL editor.
// Counts use `sum(_sample_interval)`, so they stay correct when Cloudflare samples a hot index.
import {
  ACTIVITY_V1_DISCRIMINATOR,
  ACTIVITY_V1_SLOTS,
  COMMON_SLOTS,
  METRIC_DATASET,
  UNATTRIBUTED_ACTOR,
  activityIndex,
} from "./metrics-schema.js";

/**
 * Rows of the canonical `actor` copy, for product-wide counts: `activity/v1` points scoped to
 * `actor`. Each event has exactly one actor point (owner and workspace copies are extra indexes),
 * so counting anything else double-counts events. Per-entity queries read that entity's own copy
 * instead, selected by index.
 */
const CANONICAL_ACTIVITY_ROWS =
    `${COMMON_SLOTS.discriminator} = '${ACTIVITY_V1_DISCRIMINATOR}'` +
    ` AND ${COMMON_SLOTS.scope} = 'actor'`;

/** One query per source line, so the emitted SQL carries no stray indentation. */
const lines = (...rows: string[]) => rows.join("\n");

/** A day-bucketed `timestamp > now() - INTERVAL '<days>' DAY` filter; `days` is whole days. */
const sinceDays = (days: number) => `timestamp > now() - INTERVAL '${days}' DAY`;

/** Quotes a value as a SQL string literal, doubling embedded single quotes. */
const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Product events per UTC day over the trailing `days` whole days. */
export function activityByDay(days: number): string {
  return lines(
      `SELECT formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%d') AS day,`,
      `    sum(_sample_interval) AS events`,
      `FROM ${METRIC_DATASET}`,
      `WHERE ${CANONICAL_ACTIVITY_ROWS} AND ${sinceDays(days)}`,
      `GROUP BY day`,
      `ORDER BY day ASC`);
}

/**
 * Distinct users with at least one event per UTC day over the trailing `days` whole days. Unlike
 * the additive counts, a distinct count has no sample-weighted form in the SQL dialect, so this
 * stays approximate wherever Cloudflare sampled the index.
 */
export function activeUsersByDay(days: number): string {
  return lines(
      `SELECT formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%d') AS day,`,
      `    count(DISTINCT ${COMMON_SLOTS.actorId}) AS activeUsers`,
      `FROM ${METRIC_DATASET}`,
      `WHERE ${CANONICAL_ACTIVITY_ROWS} AND ${COMMON_SLOTS.actorId} != ${sqlString(UNATTRIBUTED_ACTOR)}`,
      `    AND ${sinceDays(days)}`,
      `GROUP BY day`,
      `ORDER BY day ASC`);
}

/** Event counts per event type over the trailing `days` whole days, busiest first. */
export function activityByEventType(days: number): string {
  return lines(
      `SELECT ${COMMON_SLOTS.eventType} AS eventType,`,
      `    sum(_sample_interval) AS events`,
      `FROM ${METRIC_DATASET}`,
      `WHERE ${CANONICAL_ACTIVITY_ROWS} AND ${sinceDays(days)}`,
      `GROUP BY eventType`,
      `ORDER BY events DESC`);
}

/**
 * Workspaces with the most events over the trailing `days` whole days, hottest first. Counts the
 * workspace copy — the one point each event naming a workspace has under the workspace's index —
 * not the canonical actor copy, whose index is per-user. Grouping by `index1`, the sampling key,
 * keeps these counts exact even where the index was sampled.
 */
export function mostActiveWorkspaces(days: number, limit = 10): string {
  return lines(
      `SELECT index1 AS workspaceIndex,`,
      `    sum(_sample_interval) AS events`,
      `FROM ${METRIC_DATASET}`,
      `WHERE ${COMMON_SLOTS.discriminator} = '${ACTIVITY_V1_DISCRIMINATOR}'`,
      `    AND startsWith(index1, ${sqlString(`${activityIndex("workspace")}|`)})`,
      `    AND ${sinceDays(days)}`,
      `GROUP BY workspaceIndex`,
      `ORDER BY events DESC`,
      `LIMIT ${limit}`);
}

/**
 * One workspace's event history, newest first. `workspaceId` is the raw hex Durable Object id of
 * `ActivityMetricInput.workspaceId`; the query adds the `ws_` prefix the encoder writes.
 */
export function workspaceHistory(workspaceId: string, limit = 50): string {
  return lines(
      `SELECT timestamp,`,
      `    ${COMMON_SLOTS.eventType} AS eventType,`,
      `    ${COMMON_SLOTS.actorId} AS actorId,`,
      `    ${ACTIVITY_V1_SLOTS.detail} AS detail,`,
      `    ${ACTIVITY_V1_SLOTS.gadgetRef} AS gadgetRef`,
      `FROM ${METRIC_DATASET}`,
      `WHERE ${COMMON_SLOTS.discriminator} = '${ACTIVITY_V1_DISCRIMINATOR}'`,
      `    AND index1 = ${sqlString(activityIndex("workspace", `ws_${workspaceId}`))}`,
      `ORDER BY timestamp DESC`,
      `LIMIT ${limit}`);
}
