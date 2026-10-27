import { useCallback, useState } from "react";
import { AiChatMessage, AiChatMetadata, Overseer } from "@gadgets/workshop-shared/api";
import { RpcStub } from "capnweb";
import type { ChatContentReader } from "../code/otClient";
import { commitFileStore, type CommitFileReader } from "../code/commitFileStore";
import { rpcFailureDescription } from "../../rpcErrors";
import {
  findUnresolvedConflicts,
  listConflictedFiles,
  type UnresolvedConflict,
} from "./mergeConflicts";
import type { Toasts } from "./store/chatStore";
import type { MessageState } from "./transcript/chatDisplayEntries";

/** Props {@link useChatChanges} reads from its host component. */
export interface UseChatChangesArgs {
  overseer: RpcStub<Overseer>;
  selectedChatId: number | null;
  /** Mirrors selectedChatId for callbacks that must not capture a stale id. */
  selectedChatIdRef: { current: number | null };
  /** The selected chat's metadata, undefined while it has not loaded. */
  currentChatMetadata: AiChatMetadata | null | undefined;
  currentMessages: readonly AiChatMessage[],
  messageStates: MessageState;
  /** The selected chat's uncommitted content, checked for unresolved conflicts on accept. */
  chatContent: ChatContentReader | undefined;
  toasts: Toasts;
}

/**
 * The accept/discard/revert flows over a chat's proposed changes, including the conflict check
 * that gates accepting and the update-from-mainline dialog. Owns the flow state (the stale-accept
 * target, the update-in-flight flag, unresolved conflicts, the discard confirmation), so the host
 * component orchestrates rather than holding setters. Extracted verbatim from useChatActions.
 */
export function useChatChanges({
  overseer,
  selectedChatId,
  selectedChatIdRef,
  currentChatMetadata,
  currentMessages,
  messageStates,
  chatContent,
  toasts,
}: UseChatChangesArgs) {
  const [staleAcceptChatId, setStaleAcceptChatId] = useState<number | null>(null);
  const [isUpdatingFromMainline, setIsUpdatingFromMainline] = useState(false);
  const [unresolvedConflicts, setUnresolvedConflicts] = useState<UnresolvedConflict[] | null>(
    null);
  const [discardChangesTarget, setDiscardChangesTarget] = useState<{
    chatId: number;
  } | null>(null);
  const [discardingChangesChatIds, setDiscardingChangesChatIds] = useState(
    () => new Set<number>());

  // Handle accepting the chat's proposed changes. A merge always takes everything the chat
  // proposes -- live drafts are swept in and there is no partial accept (see
  // Overseer.mergeChanges()). Accepting is only ever a fast-forward; a "stale" outcome (mainline
  // advanced past the chat's pins) is expected control flow that opens the update-from-mainline
  // dialog rather than an error.
  const handleMergeChanges = async () => {
    if (selectedChatId === null) return;

    try {
      const result = await overseer.mergeChanges(selectedChatId);
      if (result.outcome === "stale") {
        setStaleAcceptChatId(selectedChatId);
        return;
      }
      toasts.add({ title: "Changes accepted", variant: "success" });
    } catch (err) {
      console.error("Failed to accept changes:", err);
      toasts.add({
        title: "Failed to accept changes",
        description: rpcFailureDescription(err),
        variant: "error",
      });
    }
  };

  // What "Accept changes" does. The server merges whatever the chat's files hold, so leftover
  // conflict markers are caught here: the files that the chat's merges listed as conflicted are
  // searched for one, and finding any puts the decision to the user. Content that has not
  // loaded cannot be searched, and holds nothing up. A file nobody has edited since its merge
  // is read from the commit the chat is pinned at, which the merge wrote.
  const overseerFileReader: CommitFileReader = {
    listTree: (commitId) => overseer.listTree(commitId),
    readFilesAtCommit: (commitId, paths) => overseer.readFilesAtCommit(commitId, paths),
    listChangedPaths: (fromCommit, toCommit) => overseer.listChangedPaths(fromCommit, toCommit),
  };
  const handleAcceptChanges = async () => {
    const chatId = selectedChatId;
    const reader = chatContent?.chatId === chatId ? chatContent : undefined;
    const content = reader?.read();
    if (reader !== undefined && content !== undefined) {
      const conflicted = listConflictedFiles(currentMessages, messageStates.changeStatus);
      // What is searched is the content on screen, and what the server merges is the content
      // it has been sent. While an edit is on its way the two differ, and the edit may be the
      // one that removed the last marker.
      if (conflicted.length > 0 && reader.hasLocalEdits()) {
        toasts.add({
          title: "Your latest edits are still being saved. Try accepting again in a moment.",
        });
        return;
      }
      const pins = currentChatMetadata?.codeBase?.pins ?? [];
      let unresolved: UnresolvedConflict[];
      try {
        unresolved = await findUnresolvedConflicts(
          conflicted, content,
          (gadgetId) => pins.find((pin) => pin.gadgetId === gadgetId)?.baseCommit,
          (commitId, paths) => commitFileStore.readFiles(overseerFileReader, commitId, paths));
      } catch (err) {
        console.error("Failed to check for merge conflicts:", err);
        toasts.add({ title: "Failed to check the changes for merge conflicts", variant: "error" });
        return;
      }
      if (selectedChatIdRef.current !== chatId) return;
      if (unresolved.length > 0) {
        setUnresolvedConflicts(unresolved);
        return;
      }
    }
    void handleMergeChanges();
  };

  // Merge mainline commits that landed after this chat's pins into the chat's uncommitted state
  // (see Overseer.updateChatFromMainline()). Offered when an accept comes back stale. Conflicts
  // are left inline as 3-way markers for the user (or their agent) to resolve; once the chat is
  // clean, accepting again is a plain fast-forward.
  const handleUpdateFromMainline = async () => {
    if (staleAcceptChatId === null) return;
    const chatId = staleAcceptChatId;
    setIsUpdatingFromMainline(true);
    try {
      const { conflictPaths } = await overseer.updateChatFromMainline(chatId);
      setStaleAcceptChatId(null);
      if (conflictPaths.length > 0) {
        toasts.add({
          title: `Updated this draft with the gadget's latest changes. ` +
            `${conflictPaths.length} ${conflictPaths.length === 1 ? "file has" : "files have"} ` +
            `conflicts marked in the code -- resolve them (or ask the agent to), then accept again.`,
          variant: "warning",
        });
      } else {
        toasts.add({
          title: "Updated this draft with the gadget's latest changes. Review and accept again.",
          variant: "success",
        });
      }
    } catch (err) {
      // The server refuses an update that needs a file too large to merge, in a message
      // naming the file and what to do about it (see Overseer.updateChatFromMainline()).
      console.error("Failed to update from mainline:", err);
      toasts.add({
        title: rpcFailureDescription(err) ?? "Failed to bring in the latest changes",
        variant: "error",
      });
    } finally {
      setIsUpdatingFromMainline(false);
    }
  };

  const handleFinalizeDraftChanges = async () => {
    if (selectedChatId === null) return;

    try {
      await overseer.finalizeChatDraft(selectedChatId);
      toasts.add({ title: "Changes saved", variant: "success" });
    } catch (err) {
      console.error("Failed to save changes:", err);
      toasts.add({ title: "Failed to save changes", variant: "error" });
    }
  };

  const handleDiscardDraftChanges = async () => {
    if (selectedChatId === null) return;

    try {
      // The destructive generation bump this causes prunes the buffered rows when its
      // metadata arrives (see the metadata handler).
      await overseer.discardChatDraftChanges(selectedChatId);
      toasts.add({ title: "Changes discarded", variant: "success" });
    } catch (err) {
      console.error("Failed to discard changes:", err);
      toasts.add({ title: "Failed to discard changes", variant: "error" });
    }
  };

  const handleDiscardPendingChanges = async () => {
    if (!discardChangesTarget) return;

    const target = discardChangesTarget;
    setDiscardingChangesChatIds((chatIds) => new Set(chatIds).add(target.chatId));
    try {
      // One call covers everything: live change rows are strictly newer than every materialized
      // message, so revertChanges(0) erases them along with the recorded batches (and a
      // rows-only revert degenerates to a draft discard server-side).
      await overseer.revertChanges(target.chatId, 0);
      setDiscardChangesTarget((current) =>
        current?.chatId === target.chatId ? null : current,
      );
      toasts.add({ title: "Pending changes discarded", variant: "success" });
    } catch (err) {
      console.error("Failed to discard pending changes:", err);
      // See handleRevertChanges: the server's refusals are instructive, so surface them.
      toasts.add({
        title: rpcFailureDescription(err) ?? "Failed to discard pending changes",
        variant: "error",
      });
    } finally {
      setDiscardingChangesChatIds((chatIds) => {
        const next = new Set(chatIds);
        next.delete(target.chatId);
        return next;
      });
    }
  };

  // Handle reverting changes from a specific sequence number onward
  const handleRevertChanges = useCallback(async (revertFrom: number) => {
    if (selectedChatId === null) return;

    try {
      await overseer.revertChanges(selectedChatId, revertFrom);
      toasts.add({ title: "Draft rewound", variant: "success" });
    } catch (err) {
      console.error("Failed to rewind draft:", err);
      // The server's refusals here are instructive (e.g. a still-proposed update-from-mainline
      // batch can't be reverted), so surface them rather than a generic failure.
      toasts.add({
        title: rpcFailureDescription(err) ?? "Failed to rewind draft",
        variant: "error",
      });
    }
  }, [overseer, selectedChatId, toasts]);

  return {
    staleAcceptChatId,
    setStaleAcceptChatId,
    isUpdatingFromMainline,
    unresolvedConflicts,
    setUnresolvedConflicts,
    discardChangesTarget,
    setDiscardChangesTarget,
    discardingChangesChatIds,
    handleMergeChanges,
    handleAcceptChanges,
    handleUpdateFromMainline,
    handleFinalizeDraftChanges,
    handleDiscardDraftChanges,
    handleDiscardPendingChanges,
    handleRevertChanges,
  };
}
