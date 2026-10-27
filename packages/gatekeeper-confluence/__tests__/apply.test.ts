import { APPLY_OUTCOME_UNKNOWN_MESSAGE, ActionOutcomeUnknownError, type TaggedAction } from "@gadgets/gatekeeper-kit/actions";
import { describe, expect, it } from "vitest";
import {
  ConfluenceStore,
  applyStoredAction,
  rejectStoredAction,
  revertStoredAction,
  stageAction,
  type ConfluenceAction,
  type ConfluenceKinds,
  type UploadAttachmentAction,
} from "../src/confluence-actions";
import { ConfluenceApiError, ConfluenceTransportError, type ConfluenceApi } from "../src/confluence-api";

type Storage = ConstructorParameters<typeof ConfluenceStore>[0];

// Minimal in-memory storage matching the slice of the DO storage API the store uses.
function makeStorage(map: Map<string, unknown> = new Map()): Storage {
  const kv = {
    get: <T>(k: string) => {
      const value = map.get(k);
      return value === undefined ? undefined : structuredClone(value) as T;
    },
    put: (k: string, v: unknown) => void map.set(k, structuredClone(v)),
    delete: (k: string) => void map.delete(k),
    list: <T>({ prefix }: { prefix: string }) =>
      [...map.entries()].filter(([k]) => k.startsWith(prefix))
        .map(([key, value]) => [key, structuredClone(value)] as [string, T]),
  };
  return {
    kv,
    transactionSync: <T>(callback: () => T): T => callback(),
  } as unknown as Storage;
}

type Recorded = {
  addComment: { id: string; type: string }[];
  updateContent: { title: string; status?: string }[];
  uploadAttachment: { id: string; filename: string; data: Uint8Array }[];
};

// Fake API recording the calls apply/revert make. `contentType` controls what getContentById reports;
// `status` controls whether the target page reads back as a draft or a published ("current") page.
function makeApi(contentType: "page" | "blogpost" = "page", status: string = "current") {
  const calls: Recorded = { addComment: [], updateContent: [], uploadAttachment: [] };
  const api = {
    getContentById: async (id: string) => ({
      id, type: contentType, status, title: "Title", version: { number: 3 },
      body: { storage: { value: "<p>body</p>" } },
      _links: { webui: "/spaces/ENG/pages/" + id },
    }),
    updateContent: async (b: { title: string; status?: string }) => { calls.updateContent.push(b); return {}; },
    addComment: async (id: string, _storage: string, type: string) => {
      calls.addComment.push({ id, type });
      return { id: "comment-1" };
    },
    trashContent: async () => {},
    restoreContent: async () => {},
    deleteComment: async () => {},
    deleteAttachment: async () => {},
    uploadAttachment: async (id: string, file: {filename: string; data: Uint8Array}) => {
      calls.uploadAttachment.push({id, filename: file.filename, data: file.data.slice()});
      return {id: "attachment-1"};
    },
  } as unknown as ConfluenceApi;
  return { api, calls };
}

function storeWith(api: ConfluenceApi) {
  return new ConfluenceStore(makeStorage(), api);
}

type Queue = Parameters<typeof stageAction>[1];

// An approval queue that accepts every submission.
function queue(): Queue {
  return { submitAction: async () => {} } as unknown as Queue;
}

// Stages through the real submission path, so describe and the engine's guards run.
async function stage(store: ConfluenceStore, action: ConfluenceAction): Promise<number> {
  return stageAction(store, queue(), action);
}

async function uploadAction(
  store: ConfluenceStore, data: Uint8Array, contentId = "123",
): Promise<UploadAttachmentAction> {
  return {
    type: "uploadAttachment", contentId, filename: "example.bin",
    mediaType: "application/octet-stream", file: await store.captureAttachment(data),
  };
}

describe("applyStoredAction", () => {
  it("marks the action applied so reads stop overlaying it", async () => {
    const { api } = makeApi();
    const store = storeWith(api);
    const id = await stage(store, { type: "setTitle", contentId: "123", title: "New", previousTitle: "Title" });

    await applyStoredAction(store, id);

    expect(store.getAction(id)?.state).toBe("applied");
    expect(store.pendingActions()).toHaveLength(0);
    expect(store.pendingForContent("123")).toHaveLength(0);
  });

  it("posts blog-post comments with a blogpost container type", async () => {
    const { api, calls } = makeApi("blogpost");
    const store = storeWith(api);
    const id = await stage(store, { type: "addComment", contentId: "555", text: "hi" });

    await applyStoredAction(store, id);

    expect(calls.addComment).toEqual([{ id: "555", type: "blogpost" }]);
  });

  it("posts page comments with a page container type", async () => {
    const { api, calls } = makeApi("page");
    const store = storeWith(api);
    const id = await stage(store, { type: "addComment", contentId: "555", text: "hi" });

    await applyStoredAction(store, id);

    expect(calls.addComment).toEqual([{ id: "555", type: "page" }]);
  });

  it("keeps a draft page a draft when editing its content (does not publish it)", async () => {
    const { api, calls } = makeApi("page", "draft");
    const store = storeWith(api);
    const id = await stage(store, { type: "setContent", contentId: "123", markdown: "new", previousMarkdown: "old" });

    await applyStoredAction(store, id);

    expect(calls.updateContent).toHaveLength(1);
    expect(calls.updateContent[0].status).toBe("draft");
  });

  it("publishes edits to a current page as current", async () => {
    const { api, calls } = makeApi("page", "current");
    const store = storeWith(api);
    const id = await stage(store, { type: "setContent", contentId: "123", markdown: "new", previousMarkdown: "old" });

    await applyStoredAction(store, id);

    expect(calls.updateContent[0].status).toBe("current");
  });

  it("reassembles attachment bytes, uploads once across a retried apply, and releases the file", async () => {
    const { api, calls } = makeApi();
    const store = storeWith(api);
    const data = Uint8Array.from([0, 1, 127, 128, 255]);
    const action = await uploadAction(store, data);
    const id = await stage(store, action);

    await applyStoredAction(store, id);
    await applyStoredAction(store, id);

    expect(calls.uploadAttachment).toEqual([{ id: "123", filename: "example.bin", data }]);
    expect(store.getAction(id)).toMatchObject({ state: "applied", createdAttachmentId: "attachment-1" });
    await expect(store.readAttachment(action)).rejects.toThrow(/incomplete or corrupted/);
  });

  it("retains attachment bytes after a retryable upload failure", async () => {
    const { api } = makeApi();
    api.uploadAttachment = async () => { throw new Error("temporary failure"); };
    const store = storeWith(api);
    const data = Uint8Array.from([1, 2, 3]);
    const action = await uploadAction(store, data);
    const id = await stage(store, action);

    await expect(applyStoredAction(store, id)).rejects.toThrow("temporary failure");

    expect(store.getAction(id)?.state).toBe("pending");
    await expect(store.readAttachment(action)).resolves.toEqual(data);
  });

  it("applies records queued before attachments moved to the chunk store", async () => {
    const { api, calls } = makeApi();
    const store = storeWith(api);
    const data = Uint8Array.from([4, 5, 6]);
    // Staged straight onto the journal, as the legacy row's lazy upgrade would read it.
    const id = store.journal.reserveId();
    store.journal.stage(id, {
      kind: "uploadAttachment",
      payload: { contentId: "123", filename: "legacy.bin", mediaType: "application/octet-stream", data },
    } as unknown as TaggedAction<ConfluenceKinds>);

    await applyStoredAction(store, id);

    expect(calls.uploadAttachment).toEqual([{ id: "123", filename: "legacy.bin", data }]);
    expect(store.getAction(id)?.state).toBe("applied");
  });
});

describe("claim-before-apply", () => {
  it("refuses a replayed action whose claim was left behind, marking it terminally failed", async () => {
    const { api, calls } = makeApi();
    const store = storeWith(api);
    const id = await stage(store, { type: "setTitle", contentId: "123", title: "New", previousTitle: "Title" });
    // Simulate a dispatch that died after claiming: the record still says `claimed`.
    store.journal.markClaimed(id);

    await expect(applyStoredAction(store, id)).rejects.toThrow(APPLY_OUTCOME_UNKNOWN_MESSAGE);

    expect(calls.updateContent).toHaveLength(0);
    expect(store.getAction(id)).toMatchObject({ state: "failed", failure: APPLY_OUTCOME_UNKNOWN_MESSAGE });
    // The failed record is inert: pending reads skip it, and rejection clears it.
    expect(store.pendingActions()).toHaveLength(0);
    await rejectStoredAction(store, id);
    expect(store.getAction(id)).toBeUndefined();
  });

  it("survives re-activation over adopted legacy rows (adoption is one-time per id)", () => {
    const map = new Map<string, unknown>();
    const { api } = makeApi();
    // Pre-engine bytes as the bespoke store left them: an applied update (revert trail), a
    // claimed comment (dispatch died mid-flight), a failed comment, and the next-unused counter.
    const seed = makeStorage(map);
    seed.kv.put("seq:action", 5);
    seed.kv.put("action:2", {
      action: { type: "setTitle", contentId: "123", title: "New", previousTitle: "Old" }, state: "applied",
    });
    seed.kv.put("action:3", { action: { type: "addComment", contentId: "123", text: "hi" }, state: "claimed" });
    seed.kv.put("action:4", { action: { type: "addComment", contentId: "123", text: "bye" }, state: "failed", failure: "boom" });

    const first = new ConfluenceStore(seed, api);
    expect(first.getAction(2)).toMatchObject({ state: "applied" });
    expect(first.getAction(3)).toMatchObject({ state: "failed" });
    expect(first.getAction(4)).toMatchObject({ state: "failed" });

    // A DO restart builds a fresh store (and fresh storage wrapper) over the same bytes: the
    // adoption pass must recognize its own rows instead of throwing "already issued".
    const second = new ConfluenceStore(makeStorage(map), api);
    expect(second.getAction(2)).toMatchObject({ state: "applied" });
    expect(second.getAction(3)).toMatchObject({ state: "failed" });
    expect(second.getAction(4)).toMatchObject({ state: "failed" });
  });

  it("treats a transport failure as an unknown outcome and stops retrying", async () => {
    const { api } = makeApi();
    api.updateContent = async () => { throw new ConfluenceTransportError("socket hang up"); };
    const store = storeWith(api);
    const id = await stage(store, { type: "setContent", contentId: "123", markdown: "new", previousMarkdown: "old" });

    await expect(applyStoredAction(store, id)).rejects.toThrow(ActionOutcomeUnknownError);

    expect(store.getAction(id)).toMatchObject({ state: "failed", failure: expect.stringContaining("socket hang up") });
    expect(store.pendingActions()).toHaveLength(0);
  });

  it("treats a Confluence 5xx as an unknown outcome and stops retrying", async () => {
    const { api } = makeApi();
    api.updateContent = async () => { throw new ConfluenceApiError(503, "Atlassian overloaded"); };
    const store = storeWith(api);
    const id = await stage(store, { type: "setContent", contentId: "123", markdown: "new", previousMarkdown: "old" });

    await expect(applyStoredAction(store, id)).rejects.toThrow(ActionOutcomeUnknownError);

    expect(store.getAction(id)).toMatchObject({ state: "failed" });
  });

  it("returns a retryable 4xx failure to pending, where a retry succeeds", async () => {
    const { api, calls } = makeApi();
    let failures = 1;
    api.updateContent = async (body: { title: string; status?: string }) => {
      if (failures-- > 0) throw new ConfluenceApiError(400, "bad request");
      calls.updateContent.push(body);
      return { id: "123", title: body.title };
    };
    const store = storeWith(api);
    const id = await stage(store, { type: "setContent", contentId: "123", markdown: "new", previousMarkdown: "old" });

    await expect(applyStoredAction(store, id)).rejects.toThrow("bad request");
    expect(store.getAction(id)?.state).toBe("pending");

    await applyStoredAction(store, id);

    expect(store.getAction(id)?.state).toBe("applied");
    expect(calls.updateContent).toHaveLength(1);
  });

  it("counts a claimed action as still pending for the simulation and sweep", async () => {
    const { api } = makeApi();
    const store = storeWith(api);
    const id = await stage(store, { type: "setTitle", contentId: "123", title: "New", previousTitle: "Title" });
    store.journal.markClaimed(id);

    expect(store.pendingActions()).toHaveLength(1);
    expect(store.pendingForContent("123")).toHaveLength(1);
  });

  it("refuses to reject an action whose claim is still outstanding", async () => {
    const { api } = makeApi();
    const store = storeWith(api);
    const id = await stage(store, { type: "setTitle", contentId: "123", title: "New", previousTitle: "Title" });
    store.journal.markClaimed(id);

    await expect(rejectStoredAction(store, id)).rejects.toThrow(APPLY_OUTCOME_UNKNOWN_MESSAGE);
    // The refusal marked it failed; the second rejection — the operator's explicit choice — clears it.
    expect(store.getAction(id)).toMatchObject({ state: "failed" });
    await rejectStoredAction(store, id);
    expect(store.getAction(id)).toBeUndefined();
  });
});

describe("attachment files", () => {
  it("are deleted when approval submission fails", async () => {
    const { api } = makeApi();
    const store = storeWith(api);
    const action = await uploadAction(store, Uint8Array.from([1, 2, 3]));
    const failQueue = { submitAction: async () => { throw new Error("submission failed"); } };

    await expect(stageAction(store, failQueue as never, action)).rejects.toThrow("submission failed");

    expect(store.getAction(1)).toBeUndefined();
    await expect(store.readAttachment(action)).rejects.toThrow(/incomplete or corrupted/);
  });

  it("are deleted on direct rejection, and on a stranded dependent's own rejection", async () => {
    const { api } = makeApi();
    const store = storeWith(api);
    const direct = await uploadAction(store, Uint8Array.from([1]));
    await rejectStoredAction(store, await stage(store, direct));

    const createId = await stage(store, {
      type: "createContent", provisionalId: "~parent", kind: "page",
      parent: { type: "space", spaceKey: "ENG" }, title: "Parent", status: "current",
    });
    const cascaded = await uploadAction(store, Uint8Array.from([2]), "~parent");
    const strandedId = await stage(store, cascaded);
    expect(await rejectStoredAction(store, createId)).toEqual({ restart: true });

    await expect(store.readAttachment(direct)).rejects.toThrow(/incomplete or corrupted/);
    // The engine strands the dependent as a terminal failure rather than deleting it; its staged
    // bytes are released when the user rejects that failed record.
    expect(store.getAction(strandedId)).toMatchObject({ state: "failed" });
    await expect(store.readAttachment(cascaded)).resolves.toEqual(Uint8Array.from([2]));
    await rejectStoredAction(store, strandedId);
    await expect(store.readAttachment(cascaded)).rejects.toThrow(/incomplete or corrupted/);
  });

  it("are swept on the next capture once stale and unreferenced by a pending action", async () => {
    const { api } = makeApi();
    const storage = makeStorage();
    const store = new ConfluenceStore(storage, api);
    const referenced = await uploadAction(store, Uint8Array.from([1]));
    await stage(store, referenced);
    const orphan = await uploadAction(store, Uint8Array.from([2]));
    for (const [key, value] of storage.kv.list<{ createdAt: number }>({ prefix: "confluence:actionFileAllocation:" })) {
      if (typeof value === "object") storage.kv.put(key, { ...value, createdAt: 0 });
    }

    await store.captureAttachment(Uint8Array.from([3]));

    await expect(store.readAttachment(referenced)).resolves.toEqual(Uint8Array.from([1]));
    await expect(store.readAttachment(orphan)).rejects.toThrow(/incomplete or corrupted/);
  });
});

describe("revertStoredAction", () => {
  it("removes the action on success, so it stops blocking older reverts", async () => {
    const { api } = makeApi();
    const store = storeWith(api);
    const id = await stage(store, { type: "setTitle", contentId: "123", title: "New", previousTitle: "Old" });
    await applyStoredAction(store, id);

    await revertStoredAction(store, id);

    expect(store.getAction(id)).toBeUndefined();
  });

  it("leaves the record applied when an append cannot be reverted", async () => {
    const { api } = makeApi();
    const store = storeWith(api);
    const id = await stage(store, { type: "appendContent", contentId: "123", markdown: "x" }); // no previousMarkdown
    await applyStoredAction(store, id);

    const result = await revertStoredAction(store, id);

    expect(result).toMatchObject({ message: expect.any(String) });
    expect(store.getAction(id)?.state).toBe("applied");
  });
});

describe("stageAction", () => {
  type Queue = Parameters<typeof stageAction>[1];

  // An approval queue whose submitAction rejects after `midFlight` runs — the shape of an
  // auto-approval that applied the action while the submit's reply was lost.
  function queueLosingReply(midFlight?: (id: number) => Promise<void>): Queue {
    return {
      submitAction: async (id: number, _description: unknown) => {
        if (midFlight) await midFlight(id);
        throw new Error("reply lost");
      },
    } as unknown as Queue;
  }

  it("keeps the record an auto-approval applied before the submit's reply was lost", async () => {
    const { api, calls } = makeApi();
    const store = storeWith(api);
    const action: ConfluenceAction = { type: "setTitle", contentId: "123", title: "New", previousTitle: "Title" };

    // The overseer received the action and applied it; only the reply was lost (CF-1). The
    // engine's staging treats the record as submitted and resolves rather than throwing.
    const id = await stageAction(store, queueLosingReply(id2 => applyStoredAction(store, id2)), action);
    expect(calls.updateContent).toHaveLength(1);

    // The applied record survives with its revert trail intact.
    expect(store.getAction(id)?.state).toBe("applied");
    await revertStoredAction(store, id);
    expect(store.getAction(id)).toBeUndefined();
  });

  it("keeps a claimed record a racing approval left mid-dispatch", async () => {
    const { api } = makeApi();
    const store = storeWith(api);
    const action: ConfluenceAction = { type: "setTitle", contentId: "123", title: "New", previousTitle: "Title" };

    // The racing apply took the claim but has not settled: its record is not the submit's to delete.
    const id = await stageAction(store, queueLosingReply(id2 => {
      store.journal.markClaimed(id2);
      return Promise.resolve();
    }), action);

    expect(store.getAction(id)?.state).toBe("claimed");
  });

  it("drops the record when the submit failed without a handover", async () => {
    const { api } = makeApi();
    const store = storeWith(api);
    const action: ConfluenceAction = { type: "setTitle", contentId: "123", title: "New", previousTitle: "Title" };

    await expect(stageAction(store, queueLosingReply(), action)).rejects.toThrow("reply lost");

    expect(store.pendingActions()).toEqual([]);
    expect(store.getAction(1)).toBeUndefined();
  });
});
