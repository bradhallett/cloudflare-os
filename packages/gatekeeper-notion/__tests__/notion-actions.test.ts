import { describe, expect, it, vi } from "vitest";
import {
  NotionStore,
  applyStoredAction,
  describeAction,
  findWorkspaceParentPage,
  rejectStoredAction,
  type NotionAction,
} from "../src/notion-actions";
import {
  NotionApiError,
  NotionTransportError,
  type NotionApi,
  type NotionPageResponse,
} from "../src/notion-api";
import { APPLY_OUTCOME_UNKNOWN_MESSAGE, ActionOutcomeUnknownError } from "@gadgets/gatekeeper-kit/actions";

const databaseRow = (titlePropertyName?: string) => describeAction({
  type: "createPage",
  provisionalId: "~1",
  parent: { kind: "database", databaseId: "db-1" },
  title: "Row title",
  titlePropertyName,
});

const inline = (label: string, value: string) => ({ label, kind: "inline", value });
const labels = (fields: { label: string }[] | undefined) => fields?.map(field => field.label) ?? [];

describe("describeAction", () => {
  it("names the page an edit targets", () => {
    const { description, fields, descriptionIsComplete } =
      describeAction({ type: "appendContent", pageId: "page-1", markdown: "Hello" });

    expect(descriptionIsComplete).toBe(true);
    expect(fields).toContainEqual(inline("Page ID", "page-1"));
    expect(description).not.toContain("earlier action");
  });

  it("says a provisional page ID names a page created in this workspace", () => {
    const { description, fields } = describeAction({ type: "addComment", pageId: "~3", text: "Hi" });

    expect(fields).toContainEqual(inline("Page ID", "~3"));
    expect(description).toContain("created by an earlier action in this workspace");
  });

  it("omits the title field when a database row takes its title from the properties", () => {
    const { fields } = describeAction({
      type: "createPage",
      provisionalId: "~1",
      parent: { kind: "database", databaseId: "db-1" },
      title: "Ignored",
      properties: { Task: { type: "title", text: "Real title" } },
    });

    expect(fields).toContainEqual(inline("Database ID", "db-1"));
    expect(labels(fields)).not.toContain("Title");
    expect(JSON.stringify(fields)).not.toContain("Ignored");
    expect(JSON.stringify(fields)).toContain('\\"text\\": \\"Real title\\"');
  });

  it("names the column a database row's title is written under", () => {
    const byDefault = databaseRow();
    expect(byDefault.descriptionIsComplete).toBe(true);
    expect(byDefault.fields).toContainEqual(inline("Title property", "Name"));
    expect(byDefault.fields).toContainEqual(inline("Title", "Row title"));
    const named = databaseRow("Task name");
    expect(named.descriptionIsComplete).toBe(true);
    expect(named.fields).toContainEqual(inline("Title property", "Task name"));
  });

  it("names no title column for a sub-page or a row titled by its properties", () => {
    expect(labels(describeAction({
      type: "createPage", provisionalId: "~1", parent: { kind: "page", pageId: "parent-1" },
      title: "Sub-page",
    }).fields)).not.toContain("Title property");
    expect(labels(describeAction({
      type: "createPage",
      provisionalId: "~1",
      parent: { kind: "database", databaseId: "db-1" },
      title: "Ignored",
      titlePropertyName: "Name",
      properties: { Task: { type: "title", text: "Real title" } },
    }).fields)).not.toContain("Title property");
  });

  it("shows an empty title when neither a title nor a title property is set", () => {
    const { fields } = describeAction({
      type: "createPage", provisionalId: "~1", parent: { kind: "page", pageId: "parent-1" },
    });

    expect(fields).toContainEqual(inline("Parent page ID", "parent-1"));
    expect(fields).toContainEqual(inline("Title", ""));
  });

  it("shows the workspace parent chosen at staging", () => {
    const { description, fields, descriptionIsComplete } = describeAction({
      type: "createPage",
      provisionalId: "~1",
      parent: { kind: "workspace", pageId: "recent-page", title: "Team notes" },
      title: "New page",
    });

    expect(descriptionIsComplete).toBe(true);
    expect(description).toContain("chosen now");
    expect(fields).toEqual(expect.arrayContaining([
      inline("Parent page ID", "recent-page"),
      inline("Parent page title", "Team notes"),
      inline("Provisional ID", "~1"),
      inline("Title", "New page"),
    ]));
  });
});

describe("findWorkspaceParentPage", () => {
  it("returns the most recently edited shared page", async () => {
    const searches: unknown[] = [];
    const store = {
      api: {
        search: async (body: unknown) => {
          searches.push(body);
          return {
            results: [{
              object: "page", id: "recent-page", url: "https://notion.so/recent-page",
              created_time: "2026-01-01T00:00:00Z", last_edited_time: "2026-01-02T00:00:00Z",
              properties: { title: { type: "title", title: [{ plain_text: "Team notes" }] } },
            }],
          };
        },
      },
    } as unknown as NotionStore;

    await expect(findWorkspaceParentPage(store)).resolves.toEqual({ id: "recent-page", title: "Team notes" });
    expect(searches).toEqual([{
      filter: { property: "object", value: "page" },
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: 1,
    }]);
  });
});

describe("applyStoredAction", () => {
  it("applies once: a replayed apply after the crash window is a no-op", async () => {
    const updatePage = vi.fn(async () => ({}) as NotionPageResponse);
    const { api } = makeApi();
    api.updatePage = updatePage;
    const store = storeWith(api);
    const id = await stage(store, { type: "setTitle", pageId: "page-1", title: "New", previousTitle: "Old" });

    await applyStoredAction(store, 1);
    expect(updatePage).toHaveBeenCalledTimes(1);
    expect(store.lifecycle.journal.get(id)).toMatchObject({ state: "applied" });

    // The Workshop records its approval only after the RPC returns; a restart in that window
    // replays the apply, which must settle instead of writing the title again.
    await applyStoredAction(store, id);
    expect(updatePage).toHaveBeenCalledTimes(1);
  });

  it("still throws for an unknown action id", async () => {
    const store = storeWith(makeApi().api);
    await expect(applyStoredAction(store, 4)).rejects.toThrow("Unknown pending action: 4");
  });
});

// Minimal in-memory storage matching the slice of the DO storage API NotionStore uses.
function makeKv(map: Map<string, unknown> = new Map()): DurableObjectStorage["kv"] {
  return {
    get: <T>(k: string) => {
      const value = map.get(k);
      return value === undefined ? undefined : structuredClone(value) as T;
    },
    put: (k: string, v: unknown) => void map.set(k, structuredClone(v)),
    delete: (k: string) => void map.delete(k),
    list: <T>({ prefix }: { prefix: string }) =>
      [...map.entries()].filter(([k]) => k.startsWith(prefix))
        .map(([key, value]) => [key, structuredClone(value)] as [string, T]),
  } as unknown as DurableObjectStorage["kv"];
}

// Fake API recording the calls apply makes; individual tests override methods to fail.
function makeApi() {
  const calls = { createPage: [] as unknown[], createComment: [] as unknown[], updatePage: [] as unknown[] };
  const api = {
    retrievePage: async () => ({ properties: { title: { type: "title" } } }),
    updatePage: async (id: string, body: unknown) => { calls.updatePage.push({ id, body }); return {}; },
    createComment: async (body: unknown) => { calls.createComment.push(body); return { id: "comment-1" }; },
    createPage: async (body: unknown) => { calls.createPage.push(body); return { id: "created-page" }; },
  } as unknown as NotionApi;
  return { api, calls };
}

// An approval queue that takes the submission and answers nothing (tests apply directly).
const quietQueue = {
  submitAction: async () => {},
} as unknown as Parameters<NotionStore["lifecycle"]["set"]["submit"]>[0];

function storeWith(api: NotionApi): NotionStore {
  return new NotionStore(makeKv(), api);
}

/** Stages an action through the engine, as a session would (deterministic submittedAt). */
async function stage(store: NotionStore, action: NotionAction): Promise<number> {
  const { type, ...payload } = action;
  return await store.lifecycle.set.submit(quietQueue, type, { ...payload, submittedAt: 1 });
}

describe("claim-before-apply", () => {
  it("refuses a replayed action whose claim was left behind, marking it terminally failed", async () => {
    const { api, calls } = makeApi();
    const store = storeWith(api);
    const id = await stage(store, { type: "addComment", pageId: "page-1", text: "Hi" });
    // Simulate a dispatch that died after claiming: the record still says `claimed`.
    store.lifecycle.journal.markClaimed(id);

    await expect(applyStoredAction(store, id)).rejects.toThrow(APPLY_OUTCOME_UNKNOWN_MESSAGE);

    expect(calls.createComment).toHaveLength(0);
    expect(store.lifecycle.journal.get(id)).toMatchObject({
      state: "failed", error: APPLY_OUTCOME_UNKNOWN_MESSAGE,
    });
    // The failed record is inert: pending reads skip it, and rejection clears it.
    expect(store.pendingActions()).toHaveLength(0);
    await rejectStoredAction(store, id);
    expect(store.lifecycle.journal.get(id)).toBeUndefined();
  });

  it("does not create the page twice when a crash left a claimed createPage with its real id", async () => {
    const { api, calls } = makeApi();
    const store = storeWith(api);
    const id = await stage(store, {
      type: "createPage", provisionalId: "~1", parent: { kind: "page", pageId: "parent-1" },
      title: "New", createdPageId: "created-page",
    } as NotionAction);
    // The crash window the claim guards: the API call landed and the created id was persisted,
    // but the final "applied" write never did.
    store.lifecycle.journal.markClaimed(id);

    await expect(applyStoredAction(store, id)).rejects.toThrow(APPLY_OUTCOME_UNKNOWN_MESSAGE);

    expect(calls.createPage).toHaveLength(0);
    expect(store.lifecycle.journal.get(id)).toMatchObject({
      state: "failed", action: { payload: { createdPageId: "created-page" } },
    });
  });

  it("treats a transport failure as an unknown outcome and stops retrying", async () => {
    const { api } = makeApi();
    let dispatches = 0;
    api.updatePage = async () => {
      dispatches++;
      throw new NotionTransportError("socket hang up");
    };
    const store = storeWith(api);
    const id = await stage(store, { type: "setTitle", pageId: "page-1", title: "New", previousTitle: "Old" });

    await expect(applyStoredAction(store, id)).rejects.toThrow(ActionOutcomeUnknownError);

    expect(store.lifecycle.journal.get(id)).toMatchObject({
      state: "failed", error: expect.stringContaining("socket hang up"),
    });
    expect(store.pendingActions()).toHaveLength(0);
    // A retry answers with the recorded failure instead of dispatching again.
    await expect(applyStoredAction(store, id)).rejects.toThrow("socket hang up");
    expect(dispatches).toBe(1);
  });

  it("treats a Notion 5xx as an unknown outcome and stops retrying", async () => {
    const { api } = makeApi();
    api.updatePage = async () => { throw new NotionApiError(503, "Notion overloaded"); };
    const store = storeWith(api);
    const id = await stage(store, { type: "setTitle", pageId: "page-1", title: "New", previousTitle: "Old" });

    await expect(applyStoredAction(store, id)).rejects.toThrow(ActionOutcomeUnknownError);

    expect(store.lifecycle.journal.get(id)).toMatchObject({ state: "failed" });
  });

  it("returns a retryable 4xx failure to pending, where a retry succeeds", async () => {
    const { api, calls } = makeApi();
    let failures = 1;
    api.updatePage = async (id: string, body: unknown) => {
      if (failures-- > 0) throw new NotionApiError(400, "bad request");
      calls.updatePage.push({ id, body });
      return {} as NotionPageResponse;
    };
    const store = storeWith(api);
    const id = await stage(store, { type: "setTitle", pageId: "page-1", title: "New", previousTitle: "Old" });

    await expect(applyStoredAction(store, id)).rejects.toThrow("bad request");
    expect(store.lifecycle.journal.get(id)?.state).toBe("pending");

    await applyStoredAction(store, id);

    expect(store.lifecycle.journal.get(id)?.state).toBe("applied");
    expect(calls.updatePage).toHaveLength(1);
  });

  it("counts a claimed action as still pending for the simulation", async () => {
    const { api } = makeApi();
    const store = storeWith(api);
    const id = await stage(store, { type: "setTitle", pageId: "page-1", title: "New", previousTitle: "Old" });
    store.lifecycle.journal.markClaimed(id);

    expect(store.pendingActions()).toHaveLength(1);
    expect(store.pendingForPage("page-1")).toHaveLength(1);
  });

  it("refuses to reject an action whose claim is still outstanding", async () => {
    const { api } = makeApi();
    const store = storeWith(api);
    const id = await stage(store, { type: "setTitle", pageId: "page-1", title: "New", previousTitle: "Old" });
    store.lifecycle.journal.markClaimed(id);

    await expect(rejectStoredAction(store, id)).rejects.toThrow(APPLY_OUTCOME_UNKNOWN_MESSAGE);
    // The refusal marked it failed; the second rejection — the operator's explicit choice — clears it.
    expect(store.lifecycle.journal.get(id)).toMatchObject({ state: "failed" });
    await rejectStoredAction(store, id);
    expect(store.lifecycle.journal.get(id)).toBeUndefined();
  });

  it("strands a dependent staged under a rejected page creation instead of dispatching it", async () => {
    const { api, calls } = makeApi();
    const store = storeWith(api);
    const createId = await stage(store, {
      type: "createPage", provisionalId: "~1", parent: { kind: "page", pageId: "parent-1" }, title: "New",
    });
    const dependentsId = await stage(store, { type: "addComment", pageId: "~1", text: "Hi" });

    await rejectStoredAction(store, createId);

    // The dependent is terminally failed (its reference can never resolve), not dispatchable:
    // applying it refuses without calling Notion, and rejecting clears the stranded record.
    expect(store.lifecycle.journal.get(dependentsId)).toMatchObject({ state: "failed" });
    await expect(applyStoredAction(store, dependentsId)).rejects.toThrow(/needed action 1/);
    expect(calls.createComment).toHaveLength(0);
    await rejectStoredAction(store, dependentsId);
    expect(store.lifecycle.journal.get(dependentsId)).toBeUndefined();
  });
});

describe("legacy upgrade", () => {
  it("upgrades only rows still awaiting a decision", async () => {
    const map = new Map<string, unknown>();
    const kv = makeKv(map);
    // Pre-journal bytes as the bespoke store left them: a pending edit, a comment whose dispatch
    // died mid-flight (claimed), an applied comment, and the next-unused counter.
    kv.put("seq:action", 5);
    kv.put("action:2", {
      action: { type: "setTitle", pageId: "page-1", title: "New", previousTitle: "Old" }, state: "pending",
    });
    kv.put("action:3", { action: { type: "addComment", pageId: "page-1", text: "died mid-dispatch" }, state: "claimed" });
    kv.put("action:4", { action: { type: "addComment", pageId: "page-1", text: "done" }, state: "applied" });
    const { api, calls } = makeApi();
    const store = new NotionStore(kv, api);

    // The pending row upgrades in place and applies through the engine.
    await applyStoredAction(store, 2);
    expect(calls.updatePage).toHaveLength(1);
    expect(store.lifecycle.journal.get(2)).toMatchObject({ state: "applied" });

    // The claimed row's outcome is unknowable: it must NOT reappear as re-dispatchable pending —
    // blindly re-issuing its comment would duplicate a write that may already have landed.
    await expect(applyStoredAction(store, 3)).rejects.toThrow("Unknown pending action: 3");
    expect(calls.createComment).toHaveLength(0);

    // The applied row is settled and drops from the pending view.
    await expect(applyStoredAction(store, 4)).rejects.toThrow("Unknown pending action: 4");
    expect(store.pendingActions()).toHaveLength(0);
  });
});
