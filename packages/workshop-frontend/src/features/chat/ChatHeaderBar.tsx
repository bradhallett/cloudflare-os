import { CaretLeft, Check, Pencil, Trash, X } from "@phosphor-icons/react";
import { WorkshopIconButton, WorkshopInput } from "../../components/WorkshopControls";
import { isImeComposing } from "../../keyboardEvent";

/** Props for {@link ChatHeaderBar}: the non-sidebar chat header's title view and controls. */
export interface ChatHeaderBarProps {
  sidebarMode: boolean | undefined;
  onNavigateToChat: (
    chatId: number | null,
    options?: { replace?: boolean },
  ) => void;
  isEditingTitle: boolean;
  titleInput: string;
  setTitleInput: (value: string) => void;
  handleSaveChatTitle: () => Promise<void>;
  handleCancelTitleEdit: () => void;
  /** The selected chat's title, undefined while its metadata has not loaded. */
  chatTitle: string | undefined;
  setIsEditingTitle: (edit: boolean) => void;
  handleDeleteChat: () => void;
}

/**
 * The chat sub-header shown above the transcript when the conversation list is not a sidebar:
 * the back-to-conversations button, the (editable) chat title, and the delete control. In
 * sidebar mode the list is always visible, so the parent does not render this bar at all.
 * Extracted verbatim from ChatInterface.
 */
export function ChatHeaderBar({
  sidebarMode,
  onNavigateToChat,
  isEditingTitle,
  titleInput,
  setTitleInput,
  handleSaveChatTitle,
  handleCancelTitleEdit,
  chatTitle,
  setIsEditingTitle,
  handleDeleteChat,
}: ChatHeaderBarProps) {
  return (
    <>
              {!sidebarMode && (
                <div className="flex h-12 flex-shrink-0 items-center justify-between gap-2 border-b border-kumo-line px-4">
                  <WorkshopIconButton
                    onClick={() => onNavigateToChat(null)}
                    className="!h-8 !w-8 flex-shrink-0"
                    title="Back to conversations"
                    aria-label="Back to conversations"
                  >
                    <CaretLeft size={14} />
                  </WorkshopIconButton>

                  {isEditingTitle ? (
                    <div className="flex items-center gap-1 flex-1 min-w-0">
                      <WorkshopInput
                        type="text"
                        value={titleInput}
                        onChange={(e) => setTitleInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (isImeComposing(e)) return;
                          if (e.key === "Enter") handleSaveChatTitle();
                          if (e.key === "Escape") handleCancelTitleEdit();
                        }}
                        autoFocus
                        className="!h-8 min-w-0 flex-1 bg-kumo-tint text-[13px] font-medium"
                      />
                      <WorkshopIconButton
                        onClick={handleSaveChatTitle}
                        disabled={!titleInput.trim()}
                        className="!h-8 !w-8 hover:text-kumo-brand disabled:opacity-30"
                        aria-label="Save chat title"
                      >
                        <Check size={13} />
                      </WorkshopIconButton>
                      <WorkshopIconButton
                        onClick={handleCancelTitleEdit}
                        className="!h-8 !w-8"
                        aria-label="Cancel title edit"
                      >
                        <X size={13} />
                      </WorkshopIconButton>
                    </div>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                        {chatTitle || "Chat"}
                      </span>
                      <WorkshopIconButton
                        onClick={() => setIsEditingTitle(true)}
                        className="!h-8 !w-8 flex-shrink-0 text-kumo-inactive hover:text-kumo-subtle"
                        title="Rename chat"
                        aria-label="Rename chat"
                      >
                        <Pencil size={11} />
                      </WorkshopIconButton>
                    </>
                  )}

                  <WorkshopIconButton
                    onClick={() => handleDeleteChat()}
                    danger
                    className="!h-8 !w-8 flex-shrink-0 text-kumo-inactive"
                    title="Delete chat"
                    aria-label="Delete chat"
                  >
                    <Trash size={14} />
                  </WorkshopIconButton>
                </div>
              )}
    </>
  );
}
