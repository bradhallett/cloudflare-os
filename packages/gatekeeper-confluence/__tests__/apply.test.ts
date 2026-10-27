import { APPLY_OUTCOME_UNKNOWN_MESSAGE, ActionOutcomeUnknownError } from "@gadgets/gatekeeper-kit/actions";
import { describe, expect, it } from "vitest";
import {
  ConfluenceStore,
  applyStoredAction,
  rejectStoredAction,
  revertStoredAction,
  stageAction,
  type ConfluenceAction,
  type UploadAttachmentAction,
} from "../src/confluence-actions";
import { ConfluenceApiError, ConfluenceTransportError, type ConfluenceApi } from "../src/confluence-api";

type Storage = ConstructorParameters<typeof ConfluenceStore>[0];

// Minimal in-memory storage matching the slice of the DO storage API the store uses.
function makeStorage(): Storage {
  const map = new Map<string, unknown>();
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

function stage(store: ConfluenceStore, action: ConfluenceAction): number {
  const id = store.nextActionId();
  store.putAction({ id, action, state: "pending", submittedAt: id });
  return id;
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
    const id = stage(store, { type: "setTitle", contentId: "123", title: "New", previousTitle: "Title" });

    await applyStoredAction(store, id);

    expect(store.getAction(id)?.state).toBe("applied");
    expect(store.pendingActions()).toHaveLength(0);
    expect(store.pendingForContent("123")).toHaveLength(0);
  });

  it("posts blog-post comments with a blogpost container type", async () => {
    const { api, calls } = makeApi("blogpost");
    const store = storeWith(api);
    const id = stage(store, { type: "addComment", contentId: "555", text: "hi" });

    await applyStoredAction(store, id);

    expect(calls.addComment).toEqual([{ id: "555", type: "blogpost" }]);
  });

  it("posts page comments with a page container type", async () => {
    const { api, calls } = makeApi("page");
    const store = storeWith(api);
    const id = stage(store, { type: "addComment", contentId: "555", text: "hi" });

    await applyStoredAction(store, id);

    expect(calls.addComment).toEqual([{ id: "555", type: "page" }]);
  });

  it("keeps a draft page a draft when editing its content (does not publish it)", async () => {
    const { api, calls } = makeApi("page", "draft");
    const store = storeWith(api);
    const id = stage(store, { type: "setContent", contentId: "123", markdown: "new", previousMarkdown: "old" });

    await applyStoredAction(store, id);

    expect(calls.updateContent).toHaveLength(1);
    expect(calls.updateContent[0].status).toBe("draft");
  });

  it("publishes edits to a current page as current", async () => {
    const { api, calls } = makeApi("page", "current");
    const store = storeWith(api);
    const id = stage(store, { type: "setContent", contentId: "123", markdown: "new", previousMarkdown: "old" });

    await applyStoredAction(store, id);

    expect(calls.updateContent[0].status).toBe("current");
  });

  it("reassembles attachment bytes, uploads once across a retried apply, and releases the file", async () => {
    const { api, calls } = makeApi();
    const store = storeWith(api);
    const data = Uint8Array.from([0, 1, 127, 128, 255]);
    const action = await uploadAction(store, data);
    const id = stage(store, action);

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
    const id = stage(store, action);

    await expect(applyStoredAction(store, id)).rejects.toThrow("temporary failure");

    expect(store.getAction(id)?.state).toBe("pending");
    await expect(store.readAttachment(action)).resolves.toEqual(data);
  });

  it("applies records queued before attachments moved to the chunk store", async () => {
    const { api, calls } = makeApi();
    const store = storeWith(api);
    const data = Uint8Array.from([4, 5, 6]);
    const id = stage(store, {
      type: "uploadAttachment", contentId: "123", filename: "legacy.bin",
      mediaType: "application/octet-stream", data,
    } as unknown as ConfluenceAction);

    await applyStoredAction(store, id);

    expect(calls.uploadAttachment).toEqual([{ id: "123", filename: "legacy.bin", data }]);
    expect(store.getAction(id)?.state).toBe("applied");
  });
});

describe("claim-before-apply", () => {
  it("refuses a replayed action whose claim was left behind, marking it terminally failed", async () => {
    const { api, calls } = makeApi();
    const store = storeWith(api);
    const id = stage(store, { type: "setTitle", contentId: "123", title: "New", previousTitle: "Title" });
    // Simulate a dispatch that died after claiming: the record still says `claimed`.
    store.putAction({ ...store.getAction(id)!, state: "claimed" });

    await expect(applyStoredAction(store, id)).rejects.toThrow(APPLY_OUTCOME_UNKNOWN_MESSAGE);

    expect(calls.updateContent).toHaveLength(0);
    expect(store.getAction(id)).toMatchObject({ state: "failed", failure: APPLY_OUTCOME_UNKNOWN_MESSAGE });
    // The failed record is inert: pending reads skip it, and rejection clears it.
    expect(store.pendingActions()).toHaveLength(0);
    rejectStoredAction(store, id);
    expect(store.getAction(id)).toBeUndefined();
  });

  it("treats a transport failure as an unknown outcome and stops retrying", async () => {
    const { api } = makeApi();
    api.updateContent = async () => { throw new ConfluenceTransportError("socket hang up"); };
    const store = storeWith(api);
    const id = stage(store, { type: "setContent", contentId: "123", markdown: "new", previousMarkdown: "old" });

    await expect(applyStoredAction(store, id)).rejects.toThrow(ActionOutcomeUnknownError);

    expect(store.getAction(id)).toMatchObject({ state: "failed", failure: expect.stringContaining("socket hang up") });
    expect(store.pendingActions()).toHaveLength(0);
  });

  it("treats a Confluence 5xx as an unknown outcome and stops retrying", async () => {
    const { api } = makeApi();
    api.updateContent = async () => { throw new ConfluenceApiError(503, "Atlassian overloaded"); };
    const store = storeWith(api);
    const id = stage(store, { type: "setContent", contentId: "123", markdown: "new", previousMarkdown: "old" });

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
    const id = stage(store, { type: "setContent", contentId: "123", markdown: "new", previousMarkdown: "old" });

    await expect(applyStoredAction(store, id)).rejects.toThrow("bad request");
    expect(store.getAction(id)?.state).toBe("pending");

    await applyStoredAction(store, id);

    expect(store.getAction(id)?.state).toBe("applied");
    expect(calls.updateContent).toHaveLength(1);
  });

  it("counts a claimed action as still pending for the simulation and sweep", async () => {
    const { api } = makeApi();
    const store = storeWith(api);
    const id = stage(store, { type: "setTitle", contentId: "123", title: "New", previousTitle: "Title" });
    store.putAction({ ...store.getAction(id)!, state: "claimed" });

    expect(store.pendingActions()).toHaveLength(1);
    expect(store.pendingForContent("123")).toHaveLength(1);
  });

  it("refuses to reject an action whose claim is still outstanding", async () => {
    const { api } = makeApi();
    const store = storeWith(api);
    const id = stage(store, { type: "setTitle", contentId: "123", title: "New", previousTitle: "Title" });
    store.putAction({ ...store.getAction(id)!, state: "claimed" });

    expect(() => rejectStoredAction(store, id)).toThrow(APPLY_OUTCOME_UNKNOWN_MESSAGE);
    // The refusal marked it failed; the second rejection — the operator's explicit choice — clears it.
    expect(store.getAction(id)).toMatchObject({ state: "failed" });
    rejectStoredAction(store, id);
    expect(store.getAction(id)).toBeUndefined();
  });
});

describe("attachment files", () => {
  it("are deleted when approval submission fails", async () => {
    const { api } = makeApi();
    const store = storeWith(api);
    const action = await uploadAction(store, Uint8Array.from([1, 2, 3]));
    const queue = { submitAction: async () => { throw new Error("submission failed"); } };

    await expect(stageAction(store, queue as never, action)).rejects.toThrow("submission failed");

    expect(store.getAction(1)).toBeUndefined();
    await expect(store.readAttachment(action)).rejects.toThrow(/incomplete or corrupted/);
  });

  it("are deleted on direct and cascaded rejection", async () => {
    const { api } = makeApi();
    const store = storeWith(api);
    const direct = await uploadAction(store, Uint8Array.from([1]));
    rejectStoredAction(store, stage(store, direct));

    const createId = stage(store, {
      type: "createContent", provisionalId: "~parent", kind: "page",
      parent: { type: "space", spaceKey: "ENG" }, title: "Parent", status: "current",
    });
    const cascaded = await uploadAction(store, Uint8Array.from([2]), "~parent");
    stage(store, cascaded);
    expect(rejectStoredAction(store, createId)).toEqual({ restart: true });

    await expect(store.readAttachment(direct)).rejects.toThrow(/incomplete or corrupted/);
    await expect(store.readAttachment(cascaded)).rejects.toThrow(/incomplete or corrupted/);
  });

  it("are swept on the next capture once stale and unreferenced by a pending action", async () => {
    const { api } = makeApi();
    const storage = makeStorage();
    const store = new ConfluenceStore(storage, api);
    const referenced = await uploadAction(store, Uint8Array.from([1]));
    stage(store, referenced);
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
  it("marks the action reverted on success", async () => {
    const { api } = makeApi();
    const store = storeWith(api);
    const id = stage(store, { type: "setTitle", contentId: "123", title: "New", previousTitle: "Old" });
    await applyStoredAction(store, id);

    await revertStoredAction(store, id);

    expect(store.getAction(id)?.state).toBe("reverted");
  });

  it("leaves the record applied when an append cannot be reverted", async () => {
    const { api } = makeApi();
    const store = storeWith(api);
    const id = stage(store, { type: "appendContent", contentId: "123", markdown: "x" }); // no previousMarkdown
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

    // The overseer received the action and applied it; only the reply was lost (CF-1).
    await expect(
      stageAction(store, queueLosingReply(id => applyStoredAction(store, id)), action),
    ).rejects.toThrow("reply lost");
    expect(calls.updateContent).toHaveLength(1);

    // The applied record survives with its revert trail intact.
    const record = store.allActions().find(r => r.action.type === "setTitle");
    expect(record?.state).toBe("applied");
    await revertStoredAction(store, record!.id);
    expect(store.getAction(record!.id)?.state).toBe("reverted");
  });

  it("keeps a claimed record a racing approval left mid-dispatch", async () => {
    const { api } = makeApi();
    const store = storeWith(api);
    const action: ConfluenceAction = { type: "setTitle", contentId: "123", title: "New", previousTitle: "Title" };

    // The racing apply took the claim but has not settled: its record is not the submit's to delete.
    await expect(
      stageAction(store, queueLosingReply(id => {
        const record = store.getAction(id)!;
        store.putAction({ ...record, state: "claimed" });
        return Promise.resolve();
      }), action),
    ).rejects.toThrow("reply lost");

    expect(store.allActions().find(r => r.action.type === "setTitle")?.state).toBe("claimed");
  });

  it("drops the record when the submit failed without a handover", async () => {
    const { api } = makeApi();
    const store = storeWith(api);
    const action: ConfluenceAction = { type: "setTitle", contentId: "123", title: "New", previousTitle: "Title" };

    await expect(stageAction(store, queueLosingReply(), action)).rejects.toThrow("reply lost");

    expect(store.allActions()).toEqual([]);
  });
});
