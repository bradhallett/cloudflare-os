import { describe, expect, it } from "vitest";
import {
  ACTIVITY_V1_SLOTS,
  COMMON_SLOTS,
  UNATTRIBUTED_ACTOR,
  activityIndex,
} from "../src/metrics-schema.js";
import { encodeActivityPoints } from "../src/metrics.js";
import {
  activityByDay,
  activityByEventType,
  activeUsersByDay,
  mostActiveWorkspaces,
  orgActiveSeatsByDay,
  orgGatekeeperUsageByDay,
  orgModelUsageByDay,
  workspaceHistory,
} from "../src/metrics-queries.js";

const ORG = "d".repeat(16);

// Every query the module builds; workspaceHistory returns raw rows instead.
const QUERIES = {
  activityByDay: activityByDay(30),
  activeUsersByDay: activeUsersByDay(30),
  activityByEventType: activityByEventType(30),
  mostActiveWorkspaces: mostActiveWorkspaces(30, 10),
  orgActiveSeatsByDay: orgActiveSeatsByDay(ORG, 30),
  orgGatekeeperUsageByDay: orgGatekeeperUsageByDay(ORG, 30),
  orgModelUsageByDay: orgModelUsageByDay(ORG, 30),
};

// Additive counts, which the SQL dialect corrects for sampling via sum(_sample_interval); the
// distinct-user count has no weighted form and stays approximate by design.
const ADDITIVE = {
  activityByDay: QUERIES.activityByDay,
  activityByEventType: QUERIES.activityByEventType,
  mostActiveWorkspaces: QUERIES.mostActiveWorkspaces,
  orgGatekeeperUsageByDay: QUERIES.orgGatekeeperUsageByDay,
  orgModelUsageByDay: QUERIES.orgModelUsageByDay,
};


// The slot columns the activity/v1 family actually defines, mapped back to their field names.
const KNOWN_SLOTS: Record<string, string> = Object.fromEntries(
    [...Object.entries(COMMON_SLOTS), ...Object.entries(ACTIVITY_V1_SLOTS)]
        .map(([field, slot]) => [slot, field]));

const canon = `${COMMON_SLOTS.discriminator} = 'activity/v1' AND ${COMMON_SLOTS.scope} = 'actor'`;

describe("metrics-queries", () => {
  it("reads only columns the activity/v1 schema defines", () => {
    for (const [name, query] of Object.entries(QUERIES)) {
      const unknown = [...query.matchAll(/\b(blob|double)(\d+)\b/g)]
          .map(([slot]) => slot)
          .filter((slot) => !(slot in KNOWN_SLOTS));
      expect(unknown, `${name} references unknown slots`).toEqual([]);
    }
    expect(workspaceHistory("f".repeat(16))).not.to.match(/\b(blob|double)(1[3-9]|20)\b/);
  });

  it("counts product-wide totals over the canonical actor copy only", () => {
    for (const name of ["activityByDay", "activeUsersByDay", "activityByEventType"]) {
      expect(QUERIES[name as keyof typeof QUERIES], name).toContain(canon);
    }
  });

  it("counts per-workspace totals over the workspace copy, not the actor copy", () => {
    // The actor copy's index is per-user; mixing it with the workspace index prefix would match
    // nothing. The workspace copy is the one point each event naming a workspace has.
    const query = QUERIES.mostActiveWorkspaces;
    expect(query).toContain(`${COMMON_SLOTS.discriminator} = 'activity/v1'`);
    expect(query).toContain(`startsWith(index1, '${activityIndex("workspace")}|')`);
    expect(query).not.toContain(`${COMMON_SLOTS.scope} = 'actor'`);
  });

  it("weights counts by the sample interval", () => {
    for (const [name, query] of Object.entries(ADDITIVE)) {
      expect(query, name).toContain("sum(_sample_interval)");
    }
    expect(workspaceHistory("f".repeat(16))).not.toContain("sum(_sample_interval)");
  });

  it("excludes the unattributed sentinel from user counts only", () => {
    expect(activeUsersByDay(30))
        .toContain(`${COMMON_SLOTS.actorId} != '${UNATTRIBUTED_ACTOR}'`);
    expect(activityByDay(30)).not.toContain(UNATTRIBUTED_ACTOR);
    expect(activityByEventType(30)).not.toContain(UNATTRIBUTED_ACTOR);
  });

  it("reads the workspace index the encoder writes", () => {
    const workspaceId = "c".repeat(64);
    // No owner id, so the event has exactly its actor and workspace copies.
    const points = encodeActivityPoints(
        { eventType: "workspace.opened", workspaceId, actorId: "a".repeat(64) });
    const workspaceIndex = points
        .flatMap((point) => point.indexes ?? [])
        .find((index): index is string =>
          typeof index === "string" && index.startsWith(`${activityIndex("workspace")}|`))!;

    expect(workspaceHistory(workspaceId)).toContain(`index1 = '${workspaceIndex}'`);
    expect(mostActiveWorkspaces(30))
        .toContain(`startsWith(index1, '${activityIndex("workspace")}|')`);

    // mostActiveWorkspaces' filter — discriminator plus the workspace index prefix — must match
    // exactly the one workspace copy, never the actor copy, or per-workspace counts break.
    const matching = points.filter((point) =>
      point.blobs?.[0] === "activity/v1"
      && typeof point.indexes?.[0] === "string"
      && point.indexes[0]!.startsWith(`${activityIndex("workspace")}|`));
    expect(matching).toHaveLength(1);
    expect(matching[0]!.blobs![Number(COMMON_SLOTS.scope.replace("blob", "")) - 1])
        .toBe("workspace");
  });

  it("escapes single quotes in interpolated ids", () => {
    expect(workspaceHistory("ab'cd")).toContain(`'${activityIndex("workspace", "ws_ab''cd")}'`);
    expect(orgActiveSeatsByDay("ab'cd", 30))
        .toContain(`'${activityIndex("org", "org_ab''cd")}'`);
    expect(workspaceHistory("ab'cd")).not.toContain("ws_ab'cd'");
  });

  it("builds the golden daily-activity query", () => {
    expect(activityByDay(30)).toBe(
        [
          "SELECT formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%d') AS day,",
          "    sum(_sample_interval) AS events",
          `FROM gadgets_metrics_v1`,
          `WHERE ${canon} AND timestamp > now() - INTERVAL '30' DAY`,
          "GROUP BY day",
          "ORDER BY day ASC",
        ].join("\n"));
  });

  it("counts per-org rollups over the org copy the encoder writes", () => {
    // An event naming an org has exactly one org-indexed point, whatever else it names.
    const points = encodeActivityPoints({
      eventType: "workspace.interaction", actorId: "a".repeat(64), orgId: ORG,
      detail: "chat_message_sent",
    });
    const orgPoints = points.filter((point) =>
      point.blobs?.[0] === "activity/v1"
          && typeof point.indexes?.[0] === "string"
          && point.indexes[0]!.startsWith(`${activityIndex("org")}|`));
    expect(orgPoints).toHaveLength(1);

    for (const query of [QUERIES.orgActiveSeatsByDay, QUERIES.orgGatekeeperUsageByDay,
      QUERIES.orgModelUsageByDay]) {
      expect(query).toContain(`index1 = '${activityIndex("org", `org_${ORG}`)}'`);
      expect(query).not.toContain(`${COMMON_SLOTS.scope} = 'actor'`);
    }
  });

  it("builds the golden org-seats query", () => {
    expect(orgActiveSeatsByDay("deadbeef", 30)).toBe(
        [
          "SELECT formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%d') AS day,",
          `    count(DISTINCT ${COMMON_SLOTS.actorId}) AS activeSeats`,
          "FROM gadgets_metrics_v1",
          `WHERE blob1 = 'activity/v1' AND index1 = '${activityIndex("org", "org_deadbeef")}'`,
          `    AND ${COMMON_SLOTS.actorId} != '${UNATTRIBUTED_ACTOR}'`,
          "    AND timestamp > now() - INTERVAL '30' DAY",
          "GROUP BY day",
          "ORDER BY day ASC",
        ].join("\n"));
  });

  it("builds the golden workspace-history query", () => {
    expect(workspaceHistory("deadbeef", 5)).toBe(
        [
          "SELECT timestamp,",
          `    ${COMMON_SLOTS.eventType} AS eventType,`,
          `    ${COMMON_SLOTS.actorId} AS actorId,`,
          `    ${ACTIVITY_V1_SLOTS.detail} AS detail,`,
          `    ${ACTIVITY_V1_SLOTS.gadgetRef} AS gadgetRef`,
          "FROM gadgets_metrics_v1",
          "WHERE blob1 = 'activity/v1'",
          `    AND index1 = '${activityIndex("workspace", "ws_deadbeef")}'`,
          "ORDER BY timestamp DESC",
          "LIMIT 5",
        ].join("\n"));
  });
});
