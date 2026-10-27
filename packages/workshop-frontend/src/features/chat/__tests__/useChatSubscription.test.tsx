// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// Characterization suite for the chat subscription's observable behavior (TQ-4): subscribe /
// unsubscribe lifecycle, message patching, metadata folds, and the invalidation triggers the
// transcript depends on. The assertions pin the kernel-verified wire invariants -- at-least-once
// delivery with idempotent folds, per-stream ordering, generation-keyed provisional state, and
// revision-gap/watermark handling -- at one level below the UI, so the FE-3 store rewrite can
// migrate the machinery underneath them. `probeState` is the only seam that knows the hook's
// return shape; everything else observes rendered data or the fake server's calls.

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcStub } from "capnweb";
import type {
  AiChatAuthorInfo,
  AiChatMetadata,
  AiChatHistoryPage,
  AiChatStreamEvent,
  AiChatSubscriber,
  ChatCodeBase,
  Overseer,
} from "@gadgets/workshop-shared/api";
import type { CodeChange } from "@gadgets/workshop-shared/code-change";
import { flushFrames, makeTestRoot } from "../../../action-test-harness";
import { useChatSubscription } from "../useChatSubscription";

const AGENT: AiChatAuthorInfo = { type: "agent", id: "m", name: "Model" };
const CHAT_ID = 1;

const metadata = (over: Partial<AiChatMetadata> = {}): AiChatMetadata => ({
  id: CHAT_ID,
  title: "Chat",
  started: new Date(0),
  lastActive: new Date(0),
  ...over,
});

const message = (sequence: number, over: Record<string, unknown> = {}) => ({
  chatId: CHAT_ID,
  sequence,
  timestamp: new Date(1000 + sequence),
  author: AGENT,
  type: "message",
  message: `m${sequence}`,
  ...over,
}) as Parameters<AiChatSubscriber["message"]>[0];

const NO_CHANGE: CodeChange = {};
const codeBase = (generation: number, prior?: ChatCodeBase["prior"]): ChatCodeBase =>
  ({ pins: [], generation, revision: 0, prior });

// ─── fake server ─────────────────────────────────────────────────────────────

type ChatServer = ReturnType<typeof makeChatServer>;

function makeChatServer() {
  const subscribers: AiChatSubscriber[] = [];
  const subscribeCalls: Array<[AiChatSubscriber, Date | undefined]> = [];
  const historyCalls: Array<[number, number | undefined]> = [];
  let disposed = 0;
  const responders = {
    chats: async (): Promise<AiChatMetadata[]> => [],
    history: async (): Promise<AiChatHistoryPage> => ({ messages: [] }),
  };

  const overseer = {
    subscribeToChat: (subscriber: AiChatSubscriber, startAfter?: Date) => {
      subscribers.push(subscriber);
      subscribeCalls.push([subscriber, startAfter]);
      // capnweb hands back an RpcPromise that is itself disposable (pipelining); the hook
      // stores the promise object, so the disposer must live on the promise itself.
      return Object.assign(Promise.resolve({ [Symbol.dispose]: () => { disposed++; } }), {
        [Symbol.dispose]: () => { disposed++; },
      });
    },
    listChats: () => responders.chats(),
    listModels: async () => [],
    getChatHistory: (chatId: number, beforeSequence?: number) => {
      historyCalls.push([chatId, beforeSequence]);
      return responders.history();
    },
    getChatMessage: async () => undefined,
    viewChat: () => ({ [Symbol.dispose]: () => {} }),
    onRpcBroken: (_handler: (error: unknown) => void) => {},
    // Surfaces for useActionEntries, which useChatSubscription mounts internally.
    subscribeToActions: () => Promise.resolve({ [Symbol.dispose]: () => {} }),
    listActions: async () => ({ entries: [], nextBeforeId: undefined }),
  } as unknown as RpcStub<Overseer>;

  return {
    overseer,
    responders,
    subscribeCalls,
    historyCalls,
    subscriptionCount: () => subscribeCalls.length,
    disposedCount: () => disposed,
    changeApplied: (...args: Parameters<AiChatSubscriber["changeApplied"]>) =>
      act(() => { for (const s of subscribers) s.changeApplied(...args); }),
    message: (msg: Parameters<AiChatSubscriber["message"]>[0]) =>
      act(() => { for (const s of subscribers) s.message(msg); }),
    metadata: (meta: AiChatMetadata) =>
      act(() => { for (const s of subscribers) s.metadata(meta); }),
    stream: (chatId: number, event: AiChatStreamEvent) =>
      act(() => { for (const s of subscribers) s.stream(chatId, event); }),
    streamGeneration: (generation: number) =>
      act(() => { for (const s of subscribers) s.streamGeneration(generation); }),
    deleted: (chatId: number) =>
      act(() => { for (const s of subscribers) s.deleted(chatId); }),
  };
}

// ─── probe ────────────────────────────────────────────────────────────────────

interface Observed {
  chats: string;
  messages: string;
  provisional: string;
  rows: string;
  boundaries: string;
  ready: boolean;
  loading: boolean;
}

// The migration seam (see the file comment): how the hook's latest state is read. The FE-3
// rewrite swaps this function's body for store selectors; every assertion above it stays.
function probeState(
  subscription: ReturnType<typeof useChatSubscription>,
  selectedChatId: number | null,
): Observed {
  const cache = subscription.cacheRef.current;
  const chats = [...cache.chats.entries()].toSorted((a, b) => a[0] - b[0])
    .map(([id, chat]) => `${id}:${chat.title}${chat.activeAgent ? "+active" : ""}`)
    .join(",");
  const chat = <T, >(read: (id: number) => T, or: T): T =>
    selectedChatId === null ? or : read(selectedChatId);
  return {
    chats,
    messages: chat(
      (id) => (cache.messages.get(id) ?? []).filter(Boolean)
        .map((m) => `${m.sequence}:${m.type}`).join(","),
      ""),
    provisional: chat(
      (id) => subscription.provisionalRef.current.get(id)?.text ?? "",
      ""),
    rows: chat(
      (id) => (subscription.chatChangeRowsRef.current.get(id)?.rows ?? [])
        .map((row) => `${row.generation}.${row.revision}${row.submission ? "*" : ""}`)
        .join(","),
      ""),
    boundaries: chat(
      (id) => (cache.compacted.get(id) ?? []).map((b) => `@${b.to}`).join(","),
      ""),
    ready: subscription.chatListReady,
    loading: subscription.isLoading,
  };
}

type NavigateToChat = NonNullable<Parameters<typeof useChatSubscription>[0]["onNavigateToChat"]>;

type MountOptions = {
  selectedChatId?: number | null;
  onNavigateToChat?: ReturnType<typeof vi.fn<NavigateToChat>>;
};

async function mountChat(server: ChatServer, options: MountOptions = {}) {
  const root = makeTestRoot();
  const toasts = { add: vi.fn() } as unknown as Parameters<
    typeof useChatSubscription
  >[0]["toasts"];
  const onNavigateToChat = (options.onNavigateToChat ?? vi.fn()) as unknown as NavigateToChat & {
    mock: ReturnType<typeof vi.fn<NavigateToChat>>["mock"];
  };
  let selectedChatId = options.selectedChatId ?? null;
  let currentServer = server;

  const Probe = () => {
    const subscription = useChatSubscription({
      overseer: currentServer.overseer,
      selectedChatId,
      toasts,
      onNavigateToChat,
    });
    return <pre data-testid="state">{JSON.stringify(probeState(subscription, selectedChatId))}</pre>;
  };

  const state = (): Observed => {
    const el = document.querySelector('[data-testid="state"]');
    if (!el) {
      throw new Error(`probe not mounted; body=${document.body.innerHTML.slice(0, 300)}`);
    }
    return JSON.parse(el.textContent!);
  };
  const rerender = async (patch: { server?: ChatServer; selectedChatId?: number | null }) => {
    if (patch.server) currentServer = patch.server;
    if (patch.selectedChatId !== undefined) selectedChatId = patch.selectedChatId;
    await root.render(<Probe />);
  };
  // Effects and the open handshake flush inside act; await the first render before returning.
  await root.render(<Probe />);

  return { state, rerender, toasts, onNavigateToChat, unmount: () => root.unmount() };
}

// The subscription's open handshake (subscribe + listChats/listModels) and the history load
// continue past the first act flush; draining microtasks inside act settles their state.
const settle = () => act(async () => {});

const mounted: Array<Awaited<ReturnType<typeof mountChat>>> = [];
afterEach(async () => {
  // Drain anything a test left in flight inside act before tearing roots down: unmounting a
  // root with act work still pending corrupts the act queue and silently drops the next test's
  // first commit.
  await act(async () => {});
  while (mounted.length) mounted.pop()?.unmount();
  await act(async () => {});
  document.body.innerHTML = "";
});

// ─── tests ────────────────────────────────────────────────────────────────────

describe("useChatSubscription characterization", () => {
  it("subscribes once on mount and disposes the subscription on unmount", async () => {
    const server = makeChatServer();
    const chat = await mountChat(server);
    mounted.push(chat);

    await settle();
    expect(server.subscribeCalls).toHaveLength(1);
    expect(server.disposedCount()).toBe(0);
    expect(chat.state().ready).toBe(true);

    chat.unmount();
    expect(server.disposedCount()).toBe(1);
  });

  it("keeps the list gated on chatListReady until listChats resolves", async () => {
    const server = makeChatServer();
    let releaseChats: (chats: AiChatMetadata[]) => void = () => {};
    server.responders.chats = () => new Promise((resolve) => { releaseChats = resolve; });
    const chat = await mountChat(server);
    mounted.push(chat);
    await settle();

    expect(chat.state().ready).toBe(false);
    await act(async () => { releaseChats([metadata()]); });
    expect(chat.state().ready).toBe(true);
    expect(chat.state().chats).toBe("1:Chat");
  });

  it("loads the selected chat's history once, showing the load, then the messages", async () => {
    const server = makeChatServer();
    server.responders.history = async () => ({
      messages: [message(0), message(1, { type: "changes" })],
    });
    const chat = await mountChat(server, { selectedChatId: CHAT_ID });
    mounted.push(chat);
    await settle();

    expect(chat.state().loading).toBe(false);
    expect(chat.state().messages).toBe("0:message,1:changes");
    expect(server.historyCalls).toEqual([[CHAT_ID, undefined]]);
  });

  it("navigates back to the list when the selected chat's history fails to load", async () => {
    const server = makeChatServer();
    server.responders.history = async () => { throw new Error("no such chat"); };
    const onNavigateToChat = vi.fn();
    const chat = await mountChat(server, { selectedChatId: CHAT_ID, onNavigateToChat });
    mounted.push(chat);

    expect(onNavigateToChat).toHaveBeenCalledWith(null, { replace: true });
  });

  it("folds redelivered messages idempotently by sequence", async () => {
    const server = makeChatServer();
    const chat = await mountChat(server, { selectedChatId: CHAT_ID });
    mounted.push(chat);
    await settle();

    server.message(message(0));
    server.message(message(0)); // at-least-once redelivery
    server.message(message(2));
    server.message(message(1)); // out of order within the loaded window

    expect(chat.state().messages).toBe("0:message,1:message,2:message");
  });

  it("folds redelivered change rows idempotently by generation and revision", async () => {
    const server = makeChatServer();
    const chat = await mountChat(server, { selectedChatId: CHAT_ID });
    mounted.push(chat);
    await settle();

    server.changeApplied(CHAT_ID, 2, 1, AGENT, NO_CHANGE);
    server.changeApplied(CHAT_ID, 2, 1, AGENT, NO_CHANGE); // replay of the same row
    server.changeApplied(CHAT_ID, 2, 2, AGENT, NO_CHANGE, { clientId: "c", seq: 1 });

    expect(chat.state().rows).toBe("2.1,2.2*");
  });

  it("discards provisional streaming state when the server generation changes", async () => {
    const server = makeChatServer();
    const chat = await mountChat(server, { selectedChatId: CHAT_ID });
    mounted.push(chat);
    await settle();

    server.streamGeneration(4);
    server.stream(CHAT_ID, { type: "textDelta", delta: "partial" });
    await flushFrames();
    expect(chat.state().provisional).toBe("partial");

    server.streamGeneration(5); // the DO restarted mid-stream
    expect(chat.state().provisional).toBe("");
  });

  it("mops up provisional state when the chat's agent goes inactive", async () => {
    const server = makeChatServer();
    server.responders.chats = async () => [metadata({ activeAgent: AGENT })];
    const chat = await mountChat(server, { selectedChatId: CHAT_ID });
    mounted.push(chat);
    await settle();

    server.stream(CHAT_ID, { type: "textDelta", delta: "half an answer" });
    await flushFrames();
    expect(chat.state().provisional).toBe("half an answer");

    server.metadata(metadata({ activeAgent: undefined }));
    expect(chat.state().provisional).toBe("");
  });

  it("prunes watermarked rows only within the watermark's generation", async () => {
    const server = makeChatServer();
    const chat = await mountChat(server, { selectedChatId: CHAT_ID });
    mounted.push(chat);
    await settle();

    server.changeApplied(CHAT_ID, 2, 1, AGENT, NO_CHANGE);
    server.changeApplied(CHAT_ID, 2, 2, AGENT, NO_CHANGE);
    server.changeApplied(CHAT_ID, 3, 1, AGENT, NO_CHANGE);
    server.message(message(3, {
      type: "changes",
      watermark: { changesGeneration: 2, throughRevision: 1 },
    }));

    // Rows through the watermark were absorbed into the message; later revisions and other
    // generations stay buffered.
    expect(chat.state().rows).toBe("2.2,3.1");
  });

  it("keeps the prior generation's rows on a content-preserving generation bump", async () => {
    const server = makeChatServer();
    server.responders.chats = async () => [metadata({ codeBase: codeBase(2) })];
    const chat = await mountChat(server, { selectedChatId: CHAT_ID });
    mounted.push(chat);
    await settle();

    server.changeApplied(CHAT_ID, 2, 1, AGENT, NO_CHANGE);
    server.changeApplied(CHAT_ID, 3, 1, AGENT, NO_CHANGE); // early row of the new stream

    // A merge's epoch reset: generation bumped, prior describes the closed stream.
    server.metadata(metadata({
      codeBase: codeBase(3, { generation: 2, finalRevision: 1, discontinuousGadgets: [] }),
    }));
    expect(chat.state().rows).toBe("2.1,3.1");
  });

  it("drops every row on a destructive generation bump", async () => {
    const server = makeChatServer();
    server.responders.chats = async () => [metadata({ codeBase: codeBase(2) })];
    const chat = await mountChat(server, { selectedChatId: CHAT_ID });
    mounted.push(chat);
    await settle();

    server.changeApplied(CHAT_ID, 2, 1, AGENT, NO_CHANGE);
    // Revert / draft discard: no `prior`, every buffered row was erased server-side.
    server.metadata(metadata({ codeBase: codeBase(3) }));
    expect(chat.state().rows).toBe("");
  });

  it("resubscribes on reconnect with the last message's timestamp, keeping the cache", async () => {
    const server = makeChatServer();
    const chat = await mountChat(server, { selectedChatId: CHAT_ID });
    mounted.push(chat);
    await settle();

    const last = new Date(987_654);
    server.message(message(0, { timestamp: last }));
    expect(chat.state().messages).toBe("0:message");

    const next = makeChatServer();
    await chat.rerender({ server: next });
    await settle();

    expect(server.disposedCount()).toBe(1);
    expect(next.subscribeCalls).toHaveLength(1);
    expect(next.subscribeCalls[0][1]).toEqual(last);
    // The durable cache moved with the reconnect instead of reloading.
    expect(chat.state().messages).toBe("0:message");
  });

  it("refetches the oldest boundary when a revert reaches past it", async () => {
    const server = makeChatServer();
    server.responders.history = async () => ({
      messages: [message(6)],
      compacted: { to: 5, summary: "summary" },
    });
    const chat = await mountChat(server, { selectedChatId: CHAT_ID });
    mounted.push(chat);
    await settle();
    expect(chat.state().boundaries).toBe("@5");

    server.message(message(7, { type: "revert", revertFrom: 2 }));
    await settle();

    // The page before the boundary is the one that refolds it: history(chatId, to + 1).
    expect(server.historyCalls.at(-1)).toEqual([CHAT_ID, 6]);
  });

  it("removes a deleted chat and leaves it when it was selected", async () => {
    const server = makeChatServer();
    server.responders.chats = async () => [metadata()];
    const onNavigateToChat = vi.fn();
    const chat = await mountChat(server, {
      selectedChatId: CHAT_ID,
      onNavigateToChat,
    });
    mounted.push(chat);
    await settle();

    server.deleted(CHAT_ID);
    expect(chat.state().chats).toBe("");
    expect(onNavigateToChat).toHaveBeenCalledWith(null, { replace: true });
  });

  it("serves two mounted consumers from the live stream", async () => {
    const server = makeChatServer();
    const first = await mountChat(server, { selectedChatId: CHAT_ID });
    const second = await mountChat(server, { selectedChatId: CHAT_ID });
    mounted.push(first, second);
    await settle();

    server.message(message(0));
    expect(first.state().messages).toBe("0:message");
    expect(second.state().messages).toBe("0:message");
  });

  it("toasts when a compaction found nothing to compact", async () => {
    const server = makeChatServer();
    const chat = await mountChat(server, { selectedChatId: CHAT_ID });
    mounted.push(chat);
    await settle();

    server.stream(CHAT_ID, { type: "compacted", nothingToCompact: true });
    expect(chat.toasts.add).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining("Nothing to compact") }));
  });
});
