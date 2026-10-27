/**
 * The React binding for {@link ChatStore}: a per-workspace store registry plus
 * `useSyncExternalStore` selector hooks for every slice the UI reads (the `useActions` store in
 * `useActions.ts` is the precedent). Components subscribe to exactly the slices they render —
 * replacing `useChatSubscription`'s single owner that re-rendered the whole chat interface on
 * every version bump and threaded nine child→parent notifiers (FE-3, FE-2).
 *
 * Stores live in a module-level registry for the session: the durable cache is designed to
 * survive reconnects (`ChatStore.open` resubscribes with a resume watermark), and surviving
 * remounts too means navigating away and back shows the chat instantly instead of refetching.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { RpcStub } from "capnweb";
import type { Overseer } from "@gadgets/workshop-shared/api";
import { useActionEntries } from "../../../useActions";
import {
  ChatStore,
  type NavigateToChat,
  type Toasts,
} from "./chatStore";
import type {
  ActiveFileTarget,
  ChatChangeRowBuffer,
  ChatCodeChanges,
  ChatLiveChangeRows,
  ChatLiveEditPreviews,
} from "../liveCodeStreams";
import type {
  AiChatAuthorInfo,
  AiChatMessage,
  AiChatMetadata,
} from "@gadgets/workshop-shared/api";
import type { CompactionBoundary } from "../transcript/chatDisplayEntries";
import type { ProvisionalChatState } from "../provisionalChatState";

const chatStores = new Map<string, ChatStore>();

/** The workspace's store, created on first use. */
export function getChatStore(workspaceId: string): ChatStore {
  let store = chatStores.get(workspaceId);
  if (!store) {
    store = new ChatStore(workspaceId);
    chatStores.set(workspaceId, store);
  }
  return store;
}

/** The workspace's store, stable across renders. */
function useChatWorkspaceStore(workspaceId: string): ChatStore {
  const [store] = useState(() => getChatStore(workspaceId));
  return store;
}

/**
 * Reads one slice of the workspace's chat store. Slices have stable identity until their
 * content changes (see ChatStore), so components re-render only for what they read.
 */
function useChatSlice<T>(
  workspaceId: string,
  selector: (store: ChatStore) => T,
): T {
  const store = useChatWorkspaceStore(workspaceId);
  const getSnapshot = () => selector(store);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/** All chats, most recently active first; `[]` until the list loads. */
export function useChatList(workspaceId: string): readonly AiChatMetadata[] {
  return useChatSlice(workspaceId, (store) => store.getChatList());
}

/** Whether the initial chat list has loaded. */
export function useChatListReady(workspaceId: string): boolean {
  return useChatSlice(workspaceId, (store) => store.getChatListReady());
}

/** One chat's metadata, or undefined before it arrives. */
export function useChatMetadata(
  workspaceId: string,
  chatId: number | null,
): AiChatMetadata | undefined {
  return useChatSlice(workspaceId, (store) => store.getChat(chatId));
}

/** One chat's messages, dense and ascending; `[]` while none are loaded. */
export function useChatMessages(
  workspaceId: string,
  chatId: number | null,
): readonly AiChatMessage[] {
  return useChatSlice(workspaceId, (store) => store.getMessages(chatId));
}

/** One chat's compaction boundaries, oldest first. */
export function useChatCompactions(
  workspaceId: string,
  chatId: number | null,
): readonly CompactionBoundary[] {
  return useChatSlice(workspaceId, (store) => store.getCompactions(chatId));
}

/** One chat's committed provisional streaming state (per-frame identity; null when idle). */
export function useChatProvisionalState(
  workspaceId: string,
  chatId: number | null,
): ProvisionalChatState | null {
  return useChatSlice(workspaceId, (store) => store.getProvisional(chatId));
}

/** One chat's live change-row buffer (draft banner input; null when empty). */
export function useChatRowBuffer(
  workspaceId: string,
  chatId: number | null,
): ChatChangeRowBuffer | null {
  return useChatSlice(workspaceId, (store) => store.getRowBuffer(chatId));
}

/** One chat's derived code-branch snapshot (undefined while inputs are missing or stale). */
export function useChatCodeChanges(
  workspaceId: string,
  chatId: number | null,
): ChatCodeChanges | undefined {
  return useChatSlice(workspaceId, (store) => store.getCodeChanges(chatId));
}

/** Whether one chat's history is currently fetching. */
export function useChatIsLoadingHistory(
  workspaceId: string,
  chatId: number | null,
): boolean {
  return useChatSlice(workspaceId, (store) => store.getIsLoadingHistory(chatId));
}

/** The models available for new chats. */
export function useChatModels(workspaceId: string): readonly AiChatAuthorInfo[] {
  return useChatSlice(workspaceId, (store) => store.getModels());
}

/** The stored-or-default model for new chats. */
export function useSelectedChatModel(workspaceId: string): string | null {
  return useChatSlice(workspaceId, (store) => store.getSelectedModel());
}

/** The union of every chat's proposed-change workpieces, ascending. */
export function useAnyChatProposedWorkpieces(workspaceId: string): readonly number[] {
  return useChatSlice(workspaceId, (store) => store.getAnyChatProposedWorkpieces());
}

/** The selected chat's streaming file target (see ChatStore.setOnStreamingActiveFile). */
export function useChatStreamingActiveFile(
  workspaceId: string,
  chatId: number | null,
): ActiveFileTarget | null | undefined {
  return useChatSlice(workspaceId, (store) => store.getStreamingActiveFile(chatId));
}

/** The chat's live-row stream (subscription shape; stable identity per chat). */
export function useLiveRowsStream(
  workspaceId: string,
  chatId: number | null,
): ChatLiveChangeRows | undefined {
  return useChatSlice(workspaceId, (store) => store.getLiveRows(chatId));
}

/** The chat's edit-preview stream (subscription shape; stable identity per chat). */
export function useLiveEditPreviewsStream(
  workspaceId: string,
  chatId: number | null,
): ChatLiveEditPreviews | undefined {
  return useChatSlice(workspaceId, (store) => store.getLiveEditPreviews(chatId));
}

const EMPTY_WORKPIECES: readonly number[] = [];

/**
 * The selected chat's proposed-change workpieces. Holds the last value while the chat's
 * metadata is still loading (a chat switch whose metadata hasn't arrived yet), so gadget
 * draft previews don't flash empty mid-navigation.
 */
export function useSelectedChatProposedWorkpieces(
  workspaceId: string,
  chatId: number | null,
): readonly number[] {
  const store = useChatWorkspaceStore(workspaceId);
  const lastRef = useRef<readonly number[]>(EMPTY_WORKPIECES);
  return useSyncExternalStore(
    store.subscribe,
    () => {
      if (chatId === null) return EMPTY_WORKPIECES;
      const metadata = store.getChat(chatId);
      if (metadata === undefined) return lastRef.current;
      const workpieces = metadata.proposedChangeWorkpieces ?? EMPTY_WORKPIECES;
      lastRef.current = workpieces;
      return workpieces;
    },
    () => EMPTY_WORKPIECES,
  );
}

/** Arguments for {@link useChatStoreConnection}. */
export interface UseChatStoreConnectionArgs {
  workspaceId: string;
  overseer: RpcStub<Overseer>;
  selectedChatId: number | null;
  toasts: Toasts;
  onNavigateToChat: NavigateToChat;
}

/**
 * Owns the workspace's chat subscription: opens the store on the overseer (re-opening on
 * reconnects), loads the selected chat's history once, and patches cached action cards from the
 * action log. Exactly one component per workspace calls this (the chat interface); everything
 * else reads through the selector hooks above.
 */
export function useChatStoreConnection({
  workspaceId,
  overseer,
  selectedChatId,
  toasts,
  onNavigateToChat,
}: UseChatStoreConnectionArgs): ChatStore {
  const store = useChatWorkspaceStore(workspaceId);

  // Patch cached action cards on log upserts. Declared before the refresh effect below so its
  // subscription — and the resumed flag the refresh consults — exists first.
  useActionEntries(overseer, (record) => store.patchActionMessagesFromLog(record));

  // Idempotent per render: refreshes the callbacks on the same stub, swaps subscriptions on a
  // new one, and always carries the current selection (which redirects and history loads read).
  useEffect(() => {
    store.open(overseer, toasts, onNavigateToChat, selectedChatId);
  });
  // The store outlives this component (registry), but its subscription must not.
  useEffect(() => () => store.close(), [store]);
  useEffect(() => {
    if (selectedChatId !== null) store.ensureHistory(selectedChatId);
  }, [store, selectedChatId, overseer]);
  useEffect(() => store.refreshMutableActionCards(), [store, overseer]);

  return store;
}
