import { useRef, useState } from "react";
import { AiChatMetadata, Overseer } from "@gadgets/workshop-shared/api";
import { RpcStub } from "capnweb";
import type { ChatStore, Toasts } from "./store/chatStore";

/** Props {@link useChatListActions} reads from its host component. */
export interface UseChatListActionsArgs {
  overseer: RpcStub<Overseer>;
  selectedChatId: number | null;
  /** The selected chat's metadata, undefined while it has not loaded. */
  currentChatMetadata: AiChatMetadata | null | undefined;
  /** Applies a local rename to the cached chat list (see ChatStore.renameChatLocally). */
  store: ChatStore;
  toasts: Toasts;
}

/**
 * The chat list's own flows: header title editing, list-row rename, and delete. Owns the state
 * those flows exist around (the edit inputs, the rename target, the delete confirmation), so
 * the host component orchestrates rather than holding setters. Extracted verbatim from
 * useChatActions.
 */
export function useChatListActions({
  overseer,
  selectedChatId,
  currentChatMetadata,
  store,
  toasts,
}: UseChatListActionsArgs) {
  const [titleInput, setTitleInput] = useState("");
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [renamingChatId, setRenamingChatId] = useState<number | null>(null);
  /** Which chat the list is renaming, kept in a ref so blur/commit races stay consistent. */
  const renamingChatIdRef = useRef<number | null>(null);
  const [renamingInput, setRenamingInput] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{
    id: number;
    title: string;
  } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Handle saving chat title
  const handleSaveChatTitle = async () => {
    if (selectedChatId === null || !titleInput.trim()) {
      return;
    }

    try {
      await overseer.setChatTitle(selectedChatId, titleInput.trim());

      // Apply the new title locally; the subscription redelivers it as metadata.
      store.renameChatLocally(selectedChatId, titleInput.trim());

      setIsEditingTitle(false);
      toasts.add({ title: "Chat title updated successfully", variant: "success" });
    } catch (err) {
      console.error("Failed to update chat title:", err);
      toasts.add({ title: "Failed to update chat title", variant: "error" });
    }
  };

  // Handle canceling title edit
  const handleCancelTitleEdit = () => {
    setTitleInput(currentChatMetadata?.title || "");
    setIsEditingTitle(false);
  };

  // Handle deleting a chat. Can be called from the chat header (no args) or the
  // chat list (with explicit chatId/title).
  const handleDeleteChat = (chatId?: number, chatTitle?: string) => {
    const id = chatId ?? selectedChatId;
    const title = chatTitle ?? currentChatMetadata?.title ?? "this chat";
    if (id === null || id === undefined) return;
    setDeleteTarget({ id, title });
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await overseer.deleteChat(deleteTarget.id);
      toasts.add({ title: "Chat deleted successfully", variant: "success" });
    } catch (err) {
      console.error("Failed to delete chat:", err);
      toasts.add({ title: "Failed to delete chat", variant: "error" });
    }
    setIsDeleting(false);
    setDeleteTarget(null);
  };

  const cancelListRename = () => {
    renamingChatIdRef.current = null;
    setRenamingChatId(null);
  };

  const startListRename = (chatId: number, title: string) => {
    renamingChatIdRef.current = chatId;
    setRenamingInput(title);
    setRenamingChatId(chatId);
  };

  // Handle saving a renamed chat from the list view
  const handleSaveListRename = async (chatId: number) => {
    if (renamingChatIdRef.current !== chatId) return;

    renamingChatIdRef.current = null;
    setRenamingChatId(null);

    const trimmed = renamingInput.trim();
    // Cancel on empty or no-op so commit-on-blur doesn't fire pointless RPCs.
    if (!trimmed || trimmed === store.getChat(chatId)?.title) return;

    try {
      await overseer.setChatTitle(chatId, trimmed);
      store.renameChatLocally(chatId, trimmed);
      toasts.add({ title: "Chat title updated successfully", variant: "success" });
    } catch (err) {
      console.error("Failed to update chat title:", err);
      toasts.add({ title: "Failed to update chat title", variant: "error" });
    }
  };

  return {
    titleInput,
    setTitleInput,
    isEditingTitle,
    setIsEditingTitle,
    renamingChatId,
    renamingInput,
    setRenamingInput,
    deleteTarget,
    setDeleteTarget,
    isDeleting,
    handleSaveChatTitle,
    handleCancelTitleEdit,
    handleDeleteChat,
    handleDeleteConfirm,
    cancelListRename,
    startListRename,
    handleSaveListRename,
  };
}
