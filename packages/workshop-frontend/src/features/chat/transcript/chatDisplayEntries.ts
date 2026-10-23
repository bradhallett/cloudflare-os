import type {
  AiChatAuthorInfo,
  AiChatHistoryPage,
  AiChatMessage,
  AiToolCall,
  BlueprintMerge,
  ChatCodeBase,
} from "@gadgets/workshop-shared/api";
import { composeEpochChanges, type CodeChange } from "@gadgets/workshop-shared/code-change";
import { appliedBlueprintMerges } from "../../blueprint-updates/blueprintProposal";
import {
  isObservationActionMessage,
  type ChangeChatMessage,
  type ObservationChatMessage,
} from "./messageTypes";
import { buildToolCallGroups, type ToolCallGroup, type ToolOutputResolver } from "./toolCalls";

/** A compaction checkpoint reported with a history page. */
export type CompactionBoundary = NonNullable<AiChatHistoryPage["compacted"]>;

/** Merged/reverted status of a chat's "changes" messages, with the timestamps rows reference. */
export interface MessageState {
  /** Map from sequence number to status for change messages */
  changeStatus: Map<number, "pending" | "merged" | "reverted">;

  /** Map from merge/revert sequence to the timestamp they reference */
  mergeTimestamps: Map<number, Date>; // sequence -> timestamp of merged-through message
  revertTimestamps: Map<number, Date>; // sequence -> timestamp of reverted-from message
}

/**
 * One rendered row of the chat transcript: a message, a run of agent work, a saved-edits row, a
 * blueprint-proposal row, or a compaction marker.
 */
export type ChatDisplayEntry =
  | {
      type: "compactionBoundary";
      key: string;
      boundary: CompactionBoundary;
      requestedBy?: AiChatAuthorInfo;
      /** How much of the thread the cut spared, counted in rows between it and this announcement. */
      keptRows?: number;
    }
  | {
      /**
       * Where the messages the agent still holds verbatim begin, for a boundary announced further
       * down. Shown only while that summary is open, so the two halves are read together.
       */
      type: "compactionCut";
      key: string;
      boundary: CompactionBoundary;
    }
  | {
      type: "modelChange";
      key: string;
      author: AiChatAuthorInfo;
      sequence: number;
    }
  | {
      type: "message";
      key: string;
      message: AiChatMessage;
      slashCommand?: Extract<AiChatMessage, {type: "slashCommand"}>;
      toolCalls?: AiToolCall[];
      toolCallGroups?: ToolCallGroup[];
      lastMessageSequence?: number;
    }
  | {
      type: "workRun";
      key: string;
      toolCalls: AiToolCall[];
      observations: ObservationChatMessage[];
      toolCallGroups: ToolCallGroup[];
      lastMessageSequence: number;
      lastMessageTimestamp: Date;
    }
  | {
      type: "savedChanges";
      key: string;
      message: ChangeChatMessage;
    }
  | {
      /**
       * Blueprint releases someone proposed merging into gadgets (see
       * GadgetClient.applyBlueprint()). Unlike saved edits, the row outlives the proposal's
       * acceptance or discard: the agent's review of a merge follows it with no message from
       * anyone in between, and would otherwise be answering nothing.
       */
      type: "blueprintProposal";
      key: string;
      message: ChangeChatMessage;
      merges: BlueprintMerge[];
      status: "pending" | "merged" | "reverted";
      /** Whether an agent has written in the chat since, as the one reviewing a merge does. */
      agentFollowed: boolean;
    };

type WorkMessageParts = {
  toolCalls: AiToolCall[];
  observations: ObservationChatMessage[];
  lastAgentMessageSequence: number | null;
  lastWorkSequence: number;
  lastWorkTimestamp: Date;
};

function isAssistantMessageWithoutVisibleText(msg: AiChatMessage): msg is Extract<AiChatMessage, { type: "message" }> {
  return (
    msg.type === "message" &&
    msg.author.type !== "user" &&
    !msg.message.trim() &&
    !msg.reasoning?.trim()
  );
}

/** Tool-only turns can leave behind empty assistant messages. Don't render them as transcript rows. */
export function isEmptyAssistantMessage(msg: AiChatMessage): boolean {
  return isAssistantMessageWithoutVisibleText(msg) && (!msg.toolCalls || msg.toolCalls.length === 0);
}

// Assistant messages with tool calls but no text are displayed as work rows.
function getWorkOnlyMessageParts(msg: AiChatMessage): WorkMessageParts | null {
  if (isObservationActionMessage(msg)) {
    return {
      toolCalls: [],
      observations: [msg],
      lastAgentMessageSequence: null,
      lastWorkSequence: msg.sequence,
      lastWorkTimestamp: msg.timestamp,
    };
  }

  if (
    isAssistantMessageWithoutVisibleText(msg) &&
    !!msg.toolCalls &&
    msg.toolCalls.length > 0
  ) {
    return {
      toolCalls: msg.toolCalls,
      observations: [],
      lastAgentMessageSequence: msg.sequence,
      lastWorkSequence: msg.sequence,
      lastWorkTimestamp: msg.timestamp,
    };
  }

  return null;
}

function appendWorkParts(target: WorkMessageParts, source: WorkMessageParts) {
  target.toolCalls.push(...source.toolCalls);
  target.observations.push(...source.observations);
  target.lastWorkSequence = source.lastWorkSequence;
  target.lastWorkTimestamp = source.lastWorkTimestamp;
  if (source.lastAgentMessageSequence !== null) {
    target.lastAgentMessageSequence = source.lastAgentMessageSequence;
  }
}

// Collapse adjacent work rows; fold trailing work into the preceding assistant
// message so one turn reads as one tool/resource run.
function transcriptToolCalls(toolCalls: AiToolCall[]): AiToolCall[] {
  // Successful creations render as cards (see CreatedWorkpieceChatCard); failed calls retain
  // their error summary.
  return toolCalls.filter((tc) =>
    (tc.toolName !== "createGadget" && tc.toolName !== "createWorktree") ||
    tc.output === undefined || Boolean(tc.error));
}

/**
 * Groups a chat's raw messages into the rows the transcript renders: user/agent messages with
 * their work folded in, standalone work runs, saved edits, blueprint proposals, and compaction
 * markers.
 */
export function buildChatDisplayEntries(
  messages: AiChatMessage[],
  changeStatus: ReadonlyMap<number, "pending" | "merged" | "reverted">,
  // Loaded compaction boundaries, oldest first.
  boundaries: readonly CompactionBoundary[] = [],
  outputOf?: ToolOutputResolver,
): ChatDisplayEntry[] {
  // Catalog changes are for the agent alone (see the "catalogChange" message).
  messages = messages.filter(msg => msg.type !== "catalogChange");
  const result: ChatDisplayEntry[] = [];
  let lastAgentAuthorId: string | null = null;

  // Where each boundary is announced. A cut is chosen to leave a working tail, so it lands some way
  // back from where the user typed `/compact` -- announcing it there would drop the acknowledgement
  // off screen. So a boundary is announced at the request that produced it: the `/compact` between
  // this cut and the next, since a later request can only produce a later cut. Compaction that ran
  // on its own has no request to announce at, and is announced at the cut.
  const requestFor = new Map<number, number>();
  boundaries.forEach((boundary, index) => {
    const until = boundaries[index + 1]?.to ?? Infinity;
    const request = messages.find(msg => msg.sequence >= boundary.to && msg.sequence < until &&
        msg.type === "slashCommand" && msg.request.id.builtin === true);
    if (request) requestFor.set(boundary.to, request.sequence);
  });

  // Where each cut was drawn, so the announcement can say how much of the thread survived it. Rows
  // rather than records, since rows are what the reader can count against.
  const rowsAtCut = new Map<number, number>();

  let nextBoundary = 0;
  const maybePushBoundaries = (sequence: number) => {
    while (nextBoundary < boundaries.length && boundaries[nextBoundary].to <= sequence) {
      const boundary = boundaries[nextBoundary++];
      rowsAtCut.set(boundary.to, result.length);
      // Announced at a request further down, so all that belongs here is the line showing where the
      // messages the agent still holds verbatim begin -- revealed only while the summary is open.
      result.push(requestFor.has(boundary.to)
        ? {type: "compactionCut", key: `cut-${boundary.to}`, boundary}
        : {type: "compactionBoundary", key: `compacted-${boundary.to}`, boundary});
    }
  };

  const maybePushModelChange = (msg: AiChatMessage) => {
    if (msg.type !== "message" || msg.author.type !== "agent" || isEmptyAssistantMessage(msg)) return;
    if (lastAgentAuthorId === null) {
      lastAgentAuthorId = msg.author.id;
      return;
    }
    if (msg.author.id === lastAgentAuthorId) return;
    lastAgentAuthorId = msg.author.id;
    result.push({
      type: "modelChange",
      key: `model-${msg.chatId}-${msg.sequence}`,
      author: msg.author,
      sequence: msg.sequence,
    });
  };

  const isVisibleSavedChangesMessage = (msg: AiChatMessage): msg is ChangeChatMessage =>
    msg.type === "changes" &&
    msg.author.type === "user" &&
    // A conversion boundary is the git-storage migration's bookkeeping, not a user action (see
    // AiChatMessageBody.conversionBoundary), so it never displays. Its content still reaches
    // the proposed-changes views, and the "Pending changes" banner's discard-all is the way to
    // discard it.
    msg.conversionBoundary !== true &&
    (changeStatus.get(msg.sequence) ?? "pending") === "pending";

  // Whether a "changes" message gets a row of its own, which ends the run of work before it.
  const startsOwnRow = (msg: AiChatMessage) =>
    appliedBlueprintMerges(msg).length > 0 || isVisibleSavedChangesMessage(msg);

  for (let i = 0; i < messages.length; ) {
    const msg = messages[i];
    maybePushBoundaries(msg.sequence);
    maybePushModelChange(msg);

    if (msg.type === "slashCommand") {
      // A built-in command is handled by the Workshop itself, so it has no prompt to show and gets
      // no provider reply. What it leaves behind is its boundary, announced here. A request that
      // compacted nothing has no boundary and so shows nothing, which is what happened.
      if (msg.request.id.builtin === true) {
        const announced = boundaries.find(({to}) => requestFor.get(to) === msg.sequence);
        if (announced) {
          // Everything between the cut and here survived: the tail the agent kept reading verbatim.
          // The cut's own row does not count towards it.
          const atCut = rowsAtCut.get(announced.to);
          result.push({
            type: "compactionBoundary",
            key: `compacted-${announced.to}`,
            boundary: announced,
            requestedBy: msg.author,
            keptRows: atCut === undefined ? 0 : result.length - atCut - 1,
          });
        }
        i++;
        continue;
      }
      let next = messages[i + 1];
      if (next?.type === "message" && next.generatedBySlashCommandSequence === msg.sequence) {
        result.push({
          type: "message",
          key: `slash-${msg.chatId}-${msg.sequence}`,
          message: next,
          slashCommand: msg,
        });
        i += 2;
      } else {
        result.push({
          type: "message",
          key: `slash-${msg.chatId}-${msg.sequence}`,
          message: msg,
          slashCommand: msg,
        });
        i++;
      }
      continue;
    }

    if (msg.type === "changes") {
      const merges = appliedBlueprintMerges(msg);
      if (merges.length > 0) {
        result.push({
          type: "blueprintProposal",
          key: `blueprint-proposal-${msg.chatId}-${msg.sequence}`,
          message: msg,
          merges,
          status: changeStatus.get(msg.sequence) ?? "pending",
          agentFollowed: messages.slice(i + 1).some((later) => later.author.type === "agent"),
        });
      } else if (isVisibleSavedChangesMessage(msg)) {
        result.push({
          type: "savedChanges",
          key: `saved-changes-${msg.chatId}-${msg.sequence}`,
          message: msg,
        });
      }
      i++;
      continue;
    }

    if (isEmptyAssistantMessage(msg)) {
      i++;
      continue;
    }

    const initialWorkParts = getWorkOnlyMessageParts(msg);
    if (initialWorkParts) {
      const workParts: WorkMessageParts = {
        toolCalls: [...initialWorkParts.toolCalls],
        observations: [...initialWorkParts.observations],
        lastAgentMessageSequence: initialWorkParts.lastAgentMessageSequence,
        lastWorkSequence: initialWorkParts.lastWorkSequence,
        lastWorkTimestamp: initialWorkParts.lastWorkTimestamp,
      };
      let j = i + 1;
      while (j < messages.length) {
        const nextMsg = messages[j];
        if (nextMsg.type === "changes") {
          if (startsOwnRow(nextMsg)) break;
          j++;
          continue;
        }
        const nextWorkParts = getWorkOnlyMessageParts(nextMsg);
        if (!nextWorkParts) break;
        appendWorkParts(workParts, nextWorkParts);
        j++;
      }

      result.push({
        type: "workRun",
        key: `work-${msg.chatId}-${msg.sequence}`,
        toolCalls: workParts.toolCalls,
        observations: workParts.observations,
        toolCallGroups: buildToolCallGroups(
          transcriptToolCalls(workParts.toolCalls),
          workParts.observations,
          outputOf,
        ),
        lastMessageSequence: workParts.lastAgentMessageSequence ?? workParts.lastWorkSequence,
        lastMessageTimestamp: workParts.lastWorkTimestamp,
      });

      i = j;
      continue;
    }

    if (msg.type === "message" && msg.author.type !== "user") {
      const workParts: WorkMessageParts = {
        toolCalls: msg.toolCalls ? [...msg.toolCalls] : [],
        observations: [],
        lastAgentMessageSequence: msg.sequence,
        lastWorkSequence: msg.sequence,
        lastWorkTimestamp: msg.timestamp,
      };
      let j = i + 1;
      while (j < messages.length) {
        const nextMsg = messages[j];
        if (nextMsg.type === "changes") {
          if (startsOwnRow(nextMsg)) break;
          j++;
          continue;
        }
        const nextWorkParts = getWorkOnlyMessageParts(nextMsg);
        if (!nextWorkParts) break;
        appendWorkParts(workParts, nextWorkParts);
        j++;
      }

      if (workParts.toolCalls.length > 0 || workParts.observations.length > 0) {
        result.push({
          type: "message",
          key: `msg-${msg.chatId}-${msg.sequence}`,
          message: msg,
          toolCalls: workParts.toolCalls,
          toolCallGroups: buildToolCallGroups(
            transcriptToolCalls(workParts.toolCalls),
            workParts.observations,
            outputOf,
          ),
          lastMessageSequence: workParts.lastAgentMessageSequence ?? msg.sequence,
        });
        i = j;
        continue;
      }
    }

    result.push({
      type: "message",
      key: `msg-${msg.chatId}-${msg.sequence}`,
      message: msg,
    });
    i++;
  }

  return result;
}

// Transcript spacing helpers.

/** Who sent `entry`, if it is a user's message. */
function userMessageAuthor(entry: ChatDisplayEntry | undefined): AiChatAuthorInfo | null {
  if (entry?.type !== "message") return null;
  const msg = entry.message;
  return msg.type === "slashCommand" || (msg.type === "message" && msg.author.type === "user")
    ? msg.author
    : null;
}

/** Whether `entry` renders as one of the user's own messages. */
export function isUserMessageEntry(entry: ChatDisplayEntry): boolean {
  return userMessageAuthor(entry) !== null;
}

// Consecutive messages from one user read as one group, as in any chat app: a small gap between
// them, and their name and time once, under the last.
/** Whether consecutive entries read as one user's grouped messages. */
export function continuesUserGroup(
  prev: ChatDisplayEntry | undefined,
  curr: ChatDisplayEntry | undefined,
): boolean {
  const author = userMessageAuthor(prev);
  return author !== null && author.id === userMessageAuthor(curr)?.id;
}

/**
 * How close to the top of the transcript pulls in the previous page. Roughly a screenful of slack,
 * so the messages are there by the time the user scrolls to them.
 */
export const EARLIER_PAGE_PREFETCH_PX = 600;

function isPureWorkRowEntry(entry: ChatDisplayEntry): boolean {
  if (entry.type === "workRun") return true;
  if (entry.type === "modelChange" || entry.type === "compactionBoundary" ||
      entry.type === "compactionCut") return false;
  const m = entry.message;
  return (
    m.type === "action" ||
    m.type === "useGadget" ||
    m.type === "agentCallback" ||
    m.type === "merge" ||
    m.type === "revert"
  );
}

/** Whether the entry visually ends in a work row (assistant messages with grouped work do). */
export function entryEndsInWorkRow(entry: ChatDisplayEntry): boolean {
  if (isPureWorkRowEntry(entry)) return true;
  if (entry.type !== "message") return false;
  return entry.toolCallGroups !== undefined && entry.toolCallGroups.length > 0;
}

function entryStartsWithWorkRow(entry: ChatDisplayEntry): boolean {
  if (isPureWorkRowEntry(entry)) return true;
  if (entry.type !== "message") return false;
  const m = entry.message;
  return (
    m.type === "message" &&
    m.author.type !== "user" &&
    !m.message &&
    entry.toolCallGroups !== undefined &&
    entry.toolCallGroups.length > 0
  );
}

/** Computes the top-margin rhythm class between two transcript rows. */
export function rhythmTopClass(
  prev: ChatDisplayEntry | null,
  curr: ChatDisplayEntry,
): string {
  if (!prev) return "";
  if (curr.type === "modelChange") return "mt-4";
  if (prev.type === "modelChange") return "mt-2";
  if (continuesUserGroup(prev, curr)) return "mt-2";
  if (isUserMessageEntry(prev) || isUserMessageEntry(curr)) return "mt-5";
  if (entryEndsInWorkRow(prev) && entryStartsWithWorkRow(curr)) return "mt-2";
  return "mt-4";
}

/**
 * Computes each message's merged/reverted status and the timestamps merge/revert rows reference.
 */
export function computeMessageStates(messages: AiChatMessage[]): MessageState {
  const changeStatus = new Map<number, "pending" | "merged" | "reverted">();
  const mergeTimestamps = new Map<number, Date>();
  const revertTimestamps = new Map<number, Date>();

  // Sequences of the changes still proposed as we scan
  let pending: number[] = [];

  for (let msg of messages) {
    if (msg.type === "changes") {
      pending.push(msg.sequence);
      changeStatus.set(msg.sequence, "pending");
    } else if (msg.type === "merge") {
      // Mark changes as merged and drop from active set
      while (pending.length > 0 && pending[0] <= msg.mergeThrough) {
        changeStatus.set(pending.shift()!, "merged");
      }
      // Find timestamp for the merged-through message
      const refMsg = messages.find((m) => m.sequence === msg.mergeThrough);
      if (refMsg) {
        mergeTimestamps.set(msg.sequence, refMsg.timestamp);
      }
    } else if (msg.type === "revert") {
      // Mark changes as reverted and drop from active set
      while (pending.length > 0 && pending[pending.length - 1] >= msg.revertFrom) {
        changeStatus.set(pending.pop()!, "reverted");
      }
      // Find timestamp for the reverted-from message
      const refMsg = messages.find((m) => m.sequence === msg.revertFrom);
      if (refMsg) {
        revertTimestamps.set(msg.sequence, refMsg.timestamp);
      }
    }
  }

  return { changeStatus, mergeTimestamps, revertTimestamps };
}

/**
 * The durable part of a chat's uncommitted code state (see ChatCodeChanges): the current
 * epoch's non-reverted "changes" messages composed into one change, each gadget's from its last
 * pin declaration on (see composeEpochChanges), plus the generation revision
 * their watermarks reach. `codeBase` is the chat's current ChatCodeBase; only messages at or
 * after its `epoch` participate ("at" matters for a migrated chat, whose epoch points at its own
 * conversionBoundary changes message) -- accepting changes resets the chat's code base, so
 * earlier epochs' changes are composed over pins that no longer exist. Keying the cutoff on the
 * metadata's epoch rather than on loaded merge messages keeps this consistent with the pin set
 * the code view reads from the same metadata.
 *
 * The oldest loaded compaction boundary stands in for the pages before it -- its proposedChange
 * blob, which the server refolds whenever a revert reaches across the boundary -- and drops out
 * once those pages load, since their own "changes" messages then count the same edits. The blob
 * covers sequences up to `to - 1`, so an epoch past that excludes it like any other pre-epoch
 * content.
 */
export function computeChatEpochChanges(
  messages: AiChatMessage[],
  compacted?: CompactionBoundary,
  codeBase?: ChatCodeBase,
): { epochChange?: CodeChange; rowsThrough: number } {
  const { changeStatus } = computeMessageStates(messages);
  const epoch = codeBase?.epoch;
  const generation = codeBase?.generation ?? 0;
  let seed: CodeChange | undefined;
  let rowsThrough = 0;

  if (compacted && (messages.length === 0 || messages[0].sequence >= compacted.to) &&
      (epoch === undefined || compacted.to - 1 >= epoch)) {
    seed = compacted.proposedChange;
  }

  const batches = messages.filter((msg): msg is ChangeChatMessage =>
    msg.type === "changes" && (epoch === undefined || msg.sequence >= epoch) &&
    changeStatus.get(msg.sequence) !== "reverted");
  for (const msg of batches) {
    // Revisions restart per generation, so only the current generation's watermarks position
    // the live-row cursor (an older generation's rows were retired by its closing bump).
    if (msg.watermark !== undefined && msg.watermark.changesGeneration === generation) {
      rowsThrough = Math.max(rowsThrough, msg.watermark.throughRevision);
    }
  }

  return { epochChange: composeEpochChanges(batches, seed), rowsThrough };
}

/**
 * The agent that last spoke in the chat: the author of the most recent agent message or agent error.
 * A steer was addressed to a running agent, so it never means the chat went on without one.
 */
export function inferChatAgentFromMessages(messages: AiChatMessage[]): AiChatAuthorInfo | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];

    if (msg.type === "error") {
      if (msg.author.type === "agent") {
        return msg.author;
      }
      continue;
    }

    if (msg.type === "message" && !msg.steered) {
      return msg.author.type === "agent" ? msg.author : null;
    }
  }

  return null;
}
