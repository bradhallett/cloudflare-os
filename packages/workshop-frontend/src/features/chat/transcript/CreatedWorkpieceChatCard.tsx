import type { BlueprintOutput, WorkpieceId } from "@gadgets/workshop-shared/api";
import { ArrowUpRight, GitBranch } from "@phosphor-icons/react";
import { formatOf } from "../../../components/format/formats";
import { FormatMiniature } from "../../../components/format/FormatVisuals";

/**
 * A workpiece the transcript offers to open: one card per creation recorded on a "changes"
 * message (`createdGadgets` / `createdWorktrees`), so the two kinds can never be confused.
 */
export type CreatedWorkpieceCardInfo = {
  workpieceId: WorkpieceId;
  title: string;
} & (
  | {
      type: "gadget";
      /** The creation hasn't been accepted yet: the gadget is a draft of this chat until then. */
      isPending: boolean;
      /**
       * The output format this gadget was built as, inherited from the blueprint it came from.
       * Absent for a gadget built from scratch, which reads as a generic app.
       */
      output?: BlueprintOutput;
    }
  // A worktree is private to its chat for life, so its creation is not a draft awaiting
  // acceptance (see AiChatMetadata.proposedChangeWorkpieces) and the card doesn't say so.
  | { type: "worktree" }
);

// The card's caption: what the workpiece is and what clicking does. A worktree has no app to
// preview; opening it lands on its code.
function describeCreatedWorkpiece(created: CreatedWorkpieceCardInfo): string {
  if (created.type === "worktree") return "Worktree · Click to open its code";
  const noun = formatOf(created.output).noun;
  return created.isPending
    ? `New ${noun.toLowerCase()} · Click to preview`
    : `${noun} · Click to open`;
}

/** The card the transcript shows for a workpiece a turn created. */
export function CreatedWorkpieceChatCard({
  created,
  onOpen,
}: {
  created: CreatedWorkpieceCardInfo;
  onOpen: () => void;
}) {
  return (
    <div className="group/createdApp relative w-full max-w-[440px]">
      <button
        type="button"
        onClick={onOpen}
        className="group flex w-full cursor-pointer items-stretch overflow-hidden rounded-2xl border border-kumo-line bg-kumo-base text-left shadow-[0_1px_2px_rgba(82,16,0,0.04)] transition-all duration-150 ease-out hover:-translate-y-px hover:shadow-[0_10px_28px_rgba(82,16,0,0.10)]"
      >
        <span
          className="relative grid w-[88px] flex-shrink-0 place-items-center overflow-hidden border-r border-kumo-line bg-kumo-tint/40"
          aria-hidden="true"
        >
          <span className="absolute inset-0 bg-gradient-to-br from-kumo-brand/[0.08] via-transparent to-transparent" />
          {created.type === "worktree" ? (
            <GitBranch size={28} weight="regular" className="text-kumo-subtle" />
          ) : (
            /* Drawn from the shared format vocabulary, so this card depicts a Document as a page
               rather than a generic window the moment formats exist. */
            <FormatMiniature output={created.output} />
          )}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2 px-3.5 py-3 pr-10">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-medium tracking-[-0.2px] text-kumo-default">
              {created.title}
            </span>
            <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-kumo-subtle">
              {created.type === "gadget" && created.isPending && (
                <span className="rounded-full bg-kumo-fill px-1.5 py-0.5 text-[10px] font-medium leading-none">
                  Draft
                </span>
              )}
              <span>{describeCreatedWorkpiece(created)}</span>
            </span>
          </span>
          <span className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-full text-kumo-inactive transition-all duration-150 group-hover:bg-kumo-tint group-hover:text-kumo-default">
            <ArrowUpRight size={15} weight="bold" />
          </span>
        </span>
      </button>
    </div>
  );
}
