import { useMemo } from "react";
import {
  AiChatMessage,
  BlueprintOutput,
  WorkpieceId,
} from "@gadgets/workshop-shared/api";
import {
  isEmptyAssistantMessage,
  type MessageState,
} from "./chatDisplayEntries";
import type { PendingTurnChanges } from "./pendingTurnChanges";
import {
  createdWorkpiecesOf,
  isObservationActionMessage,
  recordsOnlyWorktreeCreations,
} from "./messageTypes";
import { type CreatedWorkpieceCardInfo } from "./CreatedWorkpieceChatCard";

/** Inputs {@link usePendingTurnChanges} derives the transcript's turn structure from. */
export interface UsePendingTurnChangesArgs {
  currentMessages: AiChatMessage[];
  messageStates: MessageState;
  isAgentActive: boolean;
  /**
   * The current epoch's opening sequence (see ChatCodeBase.epoch), zero when the epoch spans
   * the whole chat.
   */
  chatEpoch: number;
  /**
   * The output format a workpiece was built as, so a created-app card can name and draw it as
   * the Document (or whatever) it is rather than a generic app.
   */
  outputOfWorkpiece: (gadgetId: WorkpieceId) => BlueprintOutput | undefined;
}

/**
 * Derives per-turn pending-change and created-workpiece structure for the transcript: which
 * changes are still pending, which agent messages close a completed turn, and which
 * workpieces each visible turn created. Behavior moved verbatim from ChatInterface.
 */
export function usePendingTurnChanges({
  currentMessages,
  messageStates,
  isAgentActive,
  chatEpoch,
  outputOfWorkpiece,
}: UsePendingTurnChangesArgs) {
  const lastDurablePendingChange = useMemo(
    () => {
      for (let i = currentMessages.length - 1; i >= 0; i--) {
        const msg = currentMessages[i];
        if (
          msg.type === "changes" &&
          messageStates.changeStatus.get(msg.sequence) === "pending"
        ) {
          return msg;
        }
      }

      return null;
    },
    [currentMessages, messageStates],
  );

  // A blueprint proposal of a release the gadget's history already holds writes no commit and
  // pins nothing, and so is not among the chat's proposedChangeWorkpieces. Its record in the log
  // is then all that says the chat has something to accept or discard (see
  // AiChatMessageBody.blueprintMerges).
  //
  // TODO: Only the loaded pages of history are looked through. A chat reopened after a
  // compaction loads what follows the checkpoint, so such a proposal recorded before it gets
  // no accept or discard until the user scrolls back that far. The fix is the one described
  // at listConflictedFiles(): the checkpoint carrying the pending merge records.
  const hasPendingBlueprintProposal = useMemo(
    () => currentMessages.some((msg) =>
      msg.type === "changes" &&
      (msg.blueprintMerges?.length ?? 0) > 0 &&
      messageStates.changeStatus.get(msg.sequence) === "pending"),
    [currentMessages, messageStates],
  );

  // Track the last visible agent message in each completed turn. This keeps hover actions like
  // copy/timestamp on the final response instead of repeating them for every streamed step.
  const completedAgentTurnMessageSeqs = useMemo(() => {
    const out = new Set<number>();
    let lastAgentMessageSeq: number | null = null;

    for (const m of currentMessages) {
      if (m.type !== "message") continue;
      if (m.author.type === "user") {
        if (lastAgentMessageSeq !== null) out.add(lastAgentMessageSeq);
        lastAgentMessageSeq = null;
      } else if (!isEmptyAssistantMessage(m)) {
        lastAgentMessageSeq = m.sequence;
      }
    }

    if (!isAgentActive && lastAgentMessageSeq !== null) {
      out.add(lastAgentMessageSeq);
    }

    return out;
  }, [currentMessages, isAgentActive]);

  const latestCompletedAgentTurnMessageSeq = useMemo(() => {
    let latest: number | null = null;
    for (const sequence of completedAgentTurnMessageSeqs) {
      if (latest === null || sequence > latest) latest = sequence;
    }
    return latest;
  }, [completedAgentTurnMessageSeqs]);

  const pendingChangeByTurnItemSeq = useMemo(() => {
    const out = new Map<number, PendingTurnChanges>();
    let lastAgentMessageSeq: number | null = null;
    let lastVisibleWorkSeq: number | null = null;
    let pendingTurnChanges: PendingTurnChanges | null = null;
    let pendingTurnAnchorSeq: number | null = null;

    const currentAnchorSeq = () => lastAgentMessageSeq ?? lastVisibleWorkSeq;

    const attachPendingTurnChanges = () => {
      if (!pendingTurnChanges) return;

      const anchorSeq = currentAnchorSeq();
      if (anchorSeq === null) return;

      if (pendingTurnAnchorSeq !== null && pendingTurnAnchorSeq !== anchorSeq) {
        out.delete(pendingTurnAnchorSeq);
      }

      out.set(anchorSeq, pendingTurnChanges);
      pendingTurnAnchorSeq = anchorSeq;
    };

    const resetTurn = () => {
      lastAgentMessageSeq = null;
      lastVisibleWorkSeq = null;
      pendingTurnChanges = null;
      pendingTurnAnchorSeq = null;
    };

    for (const m of currentMessages) {
      if (m.type === "message") {
        if (m.author.type === "user") {
          resetTurn();
        } else if (!isEmptyAssistantMessage(m)) {
          lastAgentMessageSeq = m.sequence;
          lastVisibleWorkSeq = m.sequence;
          attachPendingTurnChanges();
        }
        continue;
      }

      if (isObservationActionMessage(m) || m.type === "useGadget") {
        lastVisibleWorkSeq = m.sequence;
        attachPendingTurnChanges();
        continue;
      }

      if (m.type === "changes" && m.author.type === "user") {
        resetTurn();
        continue;
      }

      if (
        m.type === "changes" &&
        m.author.type !== "user" &&
        m.sequence >= chatEpoch &&
        (messageStates.changeStatus.get(m.sequence) ?? "pending") === "pending" &&
        !recordsOnlyWorktreeCreations(m)
      ) {
        const created = createdWorkpiecesOf(m);
        pendingTurnChanges = pendingTurnChanges === null
          ? { revertFrom: m.sequence, through: m.sequence, createdWorkpieces: created }
          : {
              revertFrom: pendingTurnChanges.revertFrom,
              through: m.sequence,
              createdWorkpieces: [...pendingTurnChanges.createdWorkpieces, ...created],
            };
        attachPendingTurnChanges();
      }
    }

    return out;
  }, [currentMessages, messageStates, chatEpoch]);

  // Accepted creations remain in the transcript; reverted gadget creations disappear, while
  // worktrees survive every revert, so their cards stay.
  const createdWorkpiecesByTurnItemSeq = useMemo(() => {
    const out = new Map<number, CreatedWorkpieceCardInfo[]>();
    let lastAgentMessageSeq: number | null = null;
    let lastVisibleWorkSeq: number | null = null;
    let creations: CreatedWorkpieceCardInfo[] = [];
    let creationAnchorSeq: number | null = null;

    const currentAnchorSeq = () => lastAgentMessageSeq ?? lastVisibleWorkSeq;

    const attachCreations = () => {
      if (creations.length === 0) return;
      const anchorSeq = currentAnchorSeq();
      if (anchorSeq === null) return;
      if (creationAnchorSeq !== null && creationAnchorSeq !== anchorSeq) {
        out.delete(creationAnchorSeq);
      }
      out.set(anchorSeq, creations);
      creationAnchorSeq = anchorSeq;
    };

    const resetTurn = () => {
      lastAgentMessageSeq = null;
      lastVisibleWorkSeq = null;
      creations = [];
      creationAnchorSeq = null;
    };

    for (const m of currentMessages) {
      if (m.type === "slashCommand" || m.type === "merge" || m.type === "revert") {
        resetTurn();
        continue;
      }

      if (m.type === "message") {
        if (m.author.type === "user") {
          resetTurn();
        } else if (!isEmptyAssistantMessage(m)) {
          lastAgentMessageSeq = m.sequence;
          lastVisibleWorkSeq = m.sequence;
          attachCreations();
        }
        continue;
      }

      if (isObservationActionMessage(m) || m.type === "useGadget") {
        lastVisibleWorkSeq = m.sequence;
        attachCreations();
        continue;
      }

      if (m.type !== "changes") continue;
      if (m.author.type === "user") {
        resetTurn();
        continue;
      }

      const status = messageStates.changeStatus.get(m.sequence) ?? "pending";
      if (!(m.createdGadgets || m.createdWorktrees)) continue;
      creations = [
        ...creations,
        ...(status === "reverted" ? [] : m.createdGadgets ?? []).map(({ gadgetId, title }): CreatedWorkpieceCardInfo => ({
          type: "gadget",
          workpieceId: gadgetId,
          title,
          isPending: status === "pending",
          output: outputOfWorkpiece(gadgetId),
        })),
        ...(m.createdWorktrees ?? []).map(({ worktreeId, title }): CreatedWorkpieceCardInfo => ({
          type: "worktree",
          workpieceId: worktreeId,
          title,
        })),
      ];
      attachCreations();
    }

    return out;
  }, [currentMessages, messageStates, outputOfWorkpiece]);

  return {
    lastDurablePendingChange,
    hasPendingBlueprintProposal,
    completedAgentTurnMessageSeqs,
    latestCompletedAgentTurnMessageSeq,
    pendingChangeByTurnItemSeq,
    createdWorkpiecesByTurnItemSeq,
  };
}
