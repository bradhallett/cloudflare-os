import { ArrowUUpLeft, PencilSimple } from "@phosphor-icons/react";
import { Tooltip } from "@cloudflare/kumo";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { formatFullTimestamp } from "../../../utils/formatTimestamp";
import type { ChatDisplayEntry } from "./chatDisplayEntries";
import { createdWorkpiecesOf, type ChangeChatMessage } from "./messageTypes";
import { getSavedEditsDiscardLabel } from "./pendingTurnChanges";

/**
 * A user's recorded edits: who saved what, with the per-message discard (and, for a
 * mainline merge, the count of files still carrying conflict markers).
 */
export function SavedChangesRow({
  entry,
  currentUser,
  chatEpoch,
  isAgentActive,
  lastDurablePendingChange,
  onRevertChanges,
  className,
}: {
  entry: Extract<ChatDisplayEntry, { type: "savedChanges" }>;
  currentUser: AiChatAuthorInfo | null;
  /** Edits from before this epoch can't be discarded individually (pre-git-storage). */
  chatEpoch: number;
  isAgentActive: boolean;
  lastDurablePendingChange: ChangeChatMessage | null;
  onRevertChanges: (revertFrom: number) => Promise<void>;
  className: string;
}) {
  const message = entry.message;
  const isOwnChange = message.author.id === currentUser?.id;
  const actor = isOwnChange ? "You" : message.author.name;
  // A user-authored creation is recorded as a "changes" message carrying createdGadgets
  // over a no-op update, so label it as a creation rather than as saved edits.
  const createdGadgets = message.createdGadgets ?? [];
  // An update-from-mainline batch merged other chats' accepted work into this draft (see
  // Overseer.updateChatFromMainline()); label it as such, including how many files still
  // carry conflict markers.
  const mainlineMerge = message.mainlineMerge;
  const conflictCount = mainlineMerge?.conflictPaths.length ?? 0;
  const label = mainlineMerge
    ? `${actor} brought the gadget's latest changes into this draft${
        conflictCount > 0
          ? ` — ${conflictCount} ${conflictCount === 1 ? "file has" : "files have"} conflicts marked in the code`
          : ""
      }`
    : createdGadgets.length > 0
    ? `${actor} created ${createdGadgets.length === 1 ? "gadget" : "gadgets"} ${
        createdGadgets.map((g) => `“${g.title}”`).join(", ")}`
    : `${actor} saved edits`;
  // A mainline merge recorded before merges were commits can't be reverted while still
  // proposed: it advanced the chat's pins with no record of where they were, and erasing it
  // would let a later accept silently overwrite the mainline content it brought in (the
  // server refuses too). One that records its `gadgets` puts the pins back.
  const irrevocableMerge =
    mainlineMerge !== undefined && mainlineMerge.gadgets === undefined;
  const isTrailing = message.sequence === lastDurablePendingChange?.sequence;
  const discardLabel = irrevocableMerge
    ? "This update can't be discarded: it brought in changes already accepted elsewhere. Edit the files instead."
    : mainlineMerge
    ? isTrailing
      ? "Discard this update"
      : "Discard this update and later changes"
    : getSavedEditsDiscardLabel(isTrailing, createdWorkpiecesOf(message));
  return (
    <div className={`${className} group/savedChanges max-w-[860px] py-1 text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle`}>
      <div className="flex items-center gap-3 px-1.5 py-1">
        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-kumo-inactive" aria-hidden="true">
          <PencilSimple size={15} />
        </span>
        <span className="min-w-0 truncate font-medium">
          {label}
        </span>
        <div className="flex flex-shrink-0 items-center gap-1 opacity-100 transition-opacity duration-150 ease-out sm:opacity-0 sm:group-hover/savedChanges:opacity-100 sm:group-focus-within/savedChanges:opacity-100">
          {/* Edits from before the current epoch (i.e. before the chat's conversion to
              git-backed storage) can't be discarded individually -- only the banner's
              discard-all covers them. */}
          {message.sequence >= chatEpoch && (
          <Tooltip content={discardLabel} asChild>
            <button
              type="button"
              disabled={isAgentActive || irrevocableMerge}
              onClick={() => onRevertChanges(message.sequence)}
              className="flex cursor-pointer items-center rounded-md p-1 text-kumo-inactive transition-[color,opacity,transform] duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
              aria-label={discardLabel}
            >
              <ArrowUUpLeft size={15} />
            </button>
          </Tooltip>
          )}
          <Tooltip content={formatFullTimestamp(message.timestamp)} asChild>
            <span className="px-1 font-mono text-[11px] leading-4 text-kumo-inactive">
              {message.timestamp.toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
