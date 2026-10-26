import { Pencil } from "@phosphor-icons/react";
import { Tooltip } from "@cloudflare/kumo";
import { formatFullTimestamp } from "../../../utils/formatTimestamp";
import { entryEndsInWorkRow, isUserMessageEntry, type ChatDisplayEntry } from "./chatDisplayEntries";
import type { ChatChangeRowBuffer } from "../liveCodeStreams";

/**
 * The live-draft banner: the user's edits that exist only as unmaterialized change rows,
 * offered as a discard or a save-as-draft while the agent is not mid-turn.
 */
export function DraftChangesRow({
  rowBuffer,
  isAgentActive,
  previousEntry,
  onDiscardDraftChanges,
  onFinalizeDraftChanges,
}: {
  rowBuffer: ChatChangeRowBuffer;
  isAgentActive: boolean;
  /** The transcript row above the banner, which sets its spacing rhythm. */
  previousEntry: ChatDisplayEntry | null;
  onDiscardDraftChanges: () => Promise<void>;
  onFinalizeDraftChanges: () => Promise<void>;
}) {
  const lastEditedAt = rowBuffer.lastUserEditAt;
  const draftTopClass = !previousEntry
    ? ""
    : isUserMessageEntry(previousEntry)
      ? "mt-6"
      : entryEndsInWorkRow(previousEntry)
        ? "mt-2"
        : "mt-4";
  return (
    <div className={`${draftTopClass} max-w-[860px] py-1 text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-1.5">
        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-kumo-inactive" aria-hidden="true">
          <Pencil size={16} />
        </span>
        <Tooltip
          content={`Your edits are still a live draft.${lastEditedAt !== null ? ` Last edited ${formatFullTimestamp(lastEditedAt)}` : ''}`}
          asChild
        >
          <span className="font-medium text-kumo-subtle">
            Draft changes pending
          </span>
        </Tooltip>
        <div className="flex flex-wrap items-center gap-2 text-[13px] leading-4">
          <Tooltip content="Throw away these draft edits." asChild>
            <button
              type="button"
              disabled={isAgentActive}
              onClick={onDiscardDraftChanges}
              className="cursor-pointer rounded-md px-1 py-0.5 font-medium text-kumo-inactive transition-colors duration-150 ease-out hover:text-kumo-danger focus-visible:text-kumo-danger focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
            >
              Discard
            </button>
          </Tooltip>
          <Tooltip content="Save these edits as a draft version. They won't affect the gadget until you accept changes." asChild>
            <button
              type="button"
              disabled={isAgentActive}
              onClick={onFinalizeDraftChanges}
              className="cursor-pointer rounded-md px-1 py-0.5 font-medium text-kumo-default transition-[color,opacity,transform] duration-150 ease-out hover:text-kumo-default-hover focus-visible:text-kumo-default-hover focus-visible:outline-none active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Save draft
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
