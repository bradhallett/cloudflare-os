import { Plug } from "@phosphor-icons/react";
import { Tooltip } from "@cloudflare/kumo";
import {
  AiChatAuthorInfo,
  AiChatMessage,
  ChatAttachmentRef,
  WorkpieceId,
} from "@gadgets/workshop-shared/api";
import { formatFullTimestamp } from "../../utils/formatTimestamp";
import { BlueprintProposalNotice } from "../blueprint-updates/BlueprintProposalNotice";
import {
  type ChangeChatMessage,
} from "./transcript/messageTypes";
import {
  type PendingTurnChanges,
} from "./transcript/pendingTurnChanges";
import {
  type ToolOutputResolver,
} from "./transcript/toolCalls";
import {
  continuesUserGroup,
  type ChatDisplayEntry,
  type MessageState,
} from "./transcript/chatDisplayEntries";
import {
  type CreatedWorkpieceCardInfo,
} from "./transcript/CreatedWorkpieceChatCard";
import { ChatTranscriptEmptyState } from "./transcript/ChatTranscriptEmptyState";
import { CompactionBoundaryRow } from "./transcript/CompactionBoundaryRow";
import { CompactionCutRow } from "./transcript/CompactionCutRow";
import { FailedSendRow } from "./transcript/FailedSendRow";
import type { FailedChatSend } from "./transcript/failedSends";
import { MergeRevertRow } from "./transcript/MergeRevertRow";
import { ModelChangeRow } from "./transcript/ModelChangeRow";
import { SavedChangesRow } from "./transcript/SavedChangesRow";
import { UserMessageRow } from "./transcript/UserMessageRow";
import { AgentMessageRow } from "./transcript/AgentMessageRow";
import { WorkRunRow } from "./transcript/WorkRunRow";
import { ErrorRow } from "./transcript/ErrorRow";
import { AgentCallbackRow } from "./transcript/AgentCallbackRow";
import { DraftChangesRow } from "./transcript/DraftChangesRow";
import { ProvisionalTurnRow } from "./transcript/ProvisionalTurnRow";
import { QueuedSteerRow } from "./transcript/QueuedSteerRow";
import {
  ActionCard,
  type AutoApproveTarget,
} from "./transcript/ActionCard";
import { ConnectionRequestCard } from "./transcript/ConnectionRequestCard";
import type { OverseerSource } from "../../components/chat/slash-command-catalog";
import type { ExpansionSet } from "./transcript/useExpansionSet";
import type { ChatChangeRowBuffer } from "./liveCodeStreams";
import type {
  ProvisionalChatState,
  ProvisionalToolCallState,
} from "./provisionalChatState";
import type { ComponentProps } from "react";
import { CONSTRAINED_CHAT_COLUMN_CLASS } from "./chatColumn";

type ActionCardResolve = ComponentProps<typeof ActionCard>["onResolve"];
type ConnectionAccept = ComponentProps<typeof ConnectionRequestCard>["onAccept"];

/**
 * Turn-scoped change bookkeeping shared by the saved-changes, work-run and message rows:
 * what the running or last turn changed, and how a row asks to revert it.
 */
export interface TranscriptTurnChanges {
  readonly lastDurablePendingChange: ChangeChatMessage | null;
  readonly pendingChangeByTurnItemSeq: Map<number, PendingTurnChanges>;
  readonly createdWorkpiecesByTurnItemSeq: Map<number, CreatedWorkpieceCardInfo[]>;
  readonly completedAgentTurnMessageSeqs: Set<number>;
  readonly latestCompletedAgentTurnMessageSeq: number | null;
  readonly handleRevertChanges: (revertFrom: number) => Promise<void>;
}

/** The expansion controller for every kind of expandable row, keyed by kind. */
export interface TranscriptExpansion {
  readonly toolCalls: ExpansionSet<string>;
  readonly actions: ExpansionSet<number>;
  readonly errors: ExpansionSet<string>;
  readonly compactions: ExpansionSet<number>;
}

/** Tool-call affordances the work-run and agent-message rows share. */
export interface TranscriptTools {
  readonly resolveToolOutput: ToolOutputResolver;
  readonly onOpenGadget: (workpieceId: WorkpieceId) => void;
  readonly getOverseer: OverseerSource;
}

/** Pending-action card affordances. */
export interface TranscriptActionCards {
  readonly processingActions: ReadonlySet<number>;
  readonly resolveAction: ActionCardResolve;
  readonly setAutoApproveConfirm: (target: AutoApproveTarget | null) => void;
  readonly isTagAutoApproved: (gatekeeperId: number, tag: string) => boolean;
  readonly handleToggleHook: (
    actionId: number,
    hookId: number,
    enabled: boolean,
  ) => Promise<void>;
}

/** Connection-request card affordances. */
export interface TranscriptConnections {
  readonly processingConnections: ReadonlySet<string>;
  readonly handleAcceptConnection: ConnectionAccept;
  readonly handleDenyConnection: (requestId: string) => Promise<void>;
}

/** Error-row retry affordances (expansion lives in {@link TranscriptExpansion}). */
export interface TranscriptErrorHandling {
  readonly setUsageModalOpen: (open: boolean) => void;
  readonly handleRetry: () => Promise<void>;
  /** The model a retry runs on — a bot chat retries on its bot's declared model, not the
   * composer's current pick (null disables the retry button). */
  readonly retryModelId: string | null;
}

/** Message affordances that are neither change- nor tool-scoped. */
export interface TranscriptMessages {
  readonly messageStates: MessageState;
  readonly handleCopyMessage: (message: string) => Promise<void>;
  readonly downloadChatAttachment: (
    chatId: number,
    attachment: ChatAttachmentRef,
  ) => Promise<void>;
}

/**
 * Props for {@link ChatTranscript}: the pane's own layout values plus one grouped object
 * per row family. A new row affordance is added to its group's interface and the group's
 * construction in ChatInterface — no per-row prop drilling through this file.
 */
export interface ChatTranscriptProps {
  isLoading: boolean;
  isLoadingEarlier: boolean;
  pendingConsoleLogCount: number;
  useConstrainedChatWidth: boolean | undefined;
  displayEntries: ChatDisplayEntry[];
  entryTopClasses: string[];
  currentUser: AiChatAuthorInfo | null;
  chatEpoch: number;
  isAgentActive: boolean;
  activeAgent: AiChatAuthorInfo | undefined;
  hideOwnUserName: boolean;
  showThinkingTraces: boolean;
  restricted: boolean | undefined;
  lastMessageSequence: number | undefined;
  currentMessages: readonly AiChatMessage[];
  queuedSteers: { text: string; author: AiChatAuthorInfo }[] | undefined;
  turnChanges: TranscriptTurnChanges;
  expansion: TranscriptExpansion;
  tools: TranscriptTools;
  actionCards: TranscriptActionCards;
  connections: TranscriptConnections;
  errorHandling: TranscriptErrorHandling;
  messages: TranscriptMessages;
  /** Re-sends a failed user send's exact payload (the row's owner drops it on success). */
  onRetryFailedSend: (send: FailedChatSend) => void;
  /** Drops a failed user send's message for good. */
  onDismissFailedSend: (send: FailedChatSend) => void;
  currentRowBuffer: ChatChangeRowBuffer | null;
  currentHasUserDraftRows: boolean;
  handleDiscardDraftChanges: () => Promise<void>;
  handleFinalizeDraftChanges: () => Promise<void>;
  currentProvisionalState: ProvisionalChatState | null;
  provisionalToolCalls: ProvisionalToolCallState[];
  isCompacting: boolean;
}

/**
 * The messages pane inside the chat's scroll container: the loading spinner, the paged
 * history, one row per display entry, the live draft/agent placeholder, and queued steers.
 * Pure dispatch — each entry type renders its own row component from transcript/; the scroll
 * container itself (and its earlier-page prefetch) stays with the parent so scroll anchoring
 * stays owned in one place.
 */
export function ChatTranscript({
  isLoading,
  isLoadingEarlier,
  pendingConsoleLogCount,
  useConstrainedChatWidth,
  displayEntries,
  entryTopClasses,
  currentUser,
  chatEpoch,
  isAgentActive,
  activeAgent,
  hideOwnUserName,
  showThinkingTraces,
  restricted,
  lastMessageSequence,
  currentMessages,
  queuedSteers,
  turnChanges,
  expansion,
  tools,
  actionCards,
  connections,
  errorHandling,
  messages,
  onRetryFailedSend,
  onDismissFailedSend,
  currentRowBuffer,
  currentHasUserDraftRows,
  handleDiscardDraftChanges,
  handleFinalizeDraftChanges,
  currentProvisionalState,
  provisionalToolCalls,
  isCompacting,
}: ChatTranscriptProps) {
  // Consecutive messages from one user read as one group, so their bubbles are rendered
  // without per-message meta; the row that ends the group carries name and time.
  const showsOwnUserName = (authorId: string) =>
    !(hideOwnUserName && authorId === currentUser?.id);
  const lastEntry = displayEntries.length > 0
    ? displayEntries[displayEntries.length - 1]
    : null;

  const renderEntry = (entry: ChatDisplayEntry, entryIndex: number) => {
    const entryTopClass = entryTopClasses[entryIndex] ?? "";
    switch (entry.type) {
      case "compactionCut":
        // Only meaningful alongside the summary it belongs to; on its own it would be a line
        // with nothing to explain it.
        return expansion.compactions.keys.has(entry.boundary.to) ? (
          <CompactionCutRow key={entry.key} className={entryTopClass} />
        ) : null;
      case "compactionBoundary":
        return (
          <CompactionBoundaryRow
            key={entry.key}
            entry={entry}
            expanded={expansion.compactions.keys.has(entry.boundary.to)}
            onToggle={expansion.compactions.toggle}
            className={entryTopClass}
          />
        );
      case "modelChange":
        return <ModelChangeRow key={entry.key} entry={entry} className={entryTopClass} />;
      case "savedChanges":
        return (
          <SavedChangesRow
            key={entry.key}
            entry={entry}
            currentUser={currentUser}
            chatEpoch={chatEpoch}
            isAgentActive={isAgentActive}
            lastDurablePendingChange={turnChanges.lastDurablePendingChange}
            onRevertChanges={turnChanges.handleRevertChanges}
            className={entryTopClass}
          />
        );
      case "blueprintProposal":
        return (
          <div key={entry.key} className={`${entryTopClass} max-w-[860px] space-y-2`}>
            {entry.merges.map((merge) => (
              <BlueprintProposalNotice
                key={merge.gadgetId}
                merge={merge}
                status={entry.status}
                reviewed={entry.agentFollowed || isAgentActive}
              />
            ))}
          </div>
        );
      case "workRun":
        return (
          <WorkRunRow
            key={entry.key}
            entry={entry}
            isAgentActive={isAgentActive}
            lastDurablePendingChange={turnChanges.lastDurablePendingChange}
            pendingChangeByTurnItemSeq={turnChanges.pendingChangeByTurnItemSeq}
            createdWorkpiecesByTurnItemSeq={turnChanges.createdWorkpiecesByTurnItemSeq}
            expandedToolCalls={expansion.toolCalls.keys}
            toggleToolCallExpansion={expansion.toolCalls.toggle}
            resolveToolOutput={tools.resolveToolOutput}
            onOpenGadget={tools.onOpenGadget}
            onRevertChanges={turnChanges.handleRevertChanges}
            className={entryTopClass}
          />
        );
      case "failedSend":
        return (
          <div key={entry.key} className={entryTopClass}>
            <FailedSendRow
              send={entry.send}
              getOverseer={tools.getOverseer}
              onRetry={onRetryFailedSend}
              onDismiss={onDismissFailedSend}
            />
          </div>
        );
      case "message":
        return (
          <MessageEntryRow
            key={entry.key}
            entry={entry}
            entryTopClass={entryTopClass}
            endsUserGroup={
              !continuesUserGroup(entry, displayEntries[entryIndex + 1])
            }
            showsOwnUserName={showsOwnUserName}
            isAgentActive={isAgentActive}
            showThinkingTraces={showThinkingTraces}
            restricted={restricted}
            lastMessageSequence={lastMessageSequence}
            turnChanges={turnChanges}
            expansion={expansion}
            tools={tools}
            actionCards={actionCards}
            connections={connections}
            errorHandling={errorHandling}
            messages={messages}
          />
        );
    }
  };

  return (
    <>
      {isLoading ? (
        <div className="flex items-center justify-center py-10">
          <div className="w-5 h-5 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        // role=log gives polite announcements for appended entries; busy for the whole
        // turn (activeAgent is steady, unlike the provisional state, which flickers
        // empty between the turn's model calls) holds them until the message finalizes.
        <div
          role="log"
          aria-busy={isAgentActive}
          className={`flex flex-col px-3 pt-5 sm:px-6 sm:pt-8 ${pendingConsoleLogCount > 0 ? "pb-16" : "pb-8"} ${useConstrainedChatWidth ? CONSTRAINED_CHAT_COLUMN_CLASS : ""}`}
        >
          {displayEntries.length === 0 && !isAgentActive && (
            <ChatTranscriptEmptyState />
          )}

          {isLoadingEarlier && (
            <div className="mx-auto mb-6 text-[12px] leading-4 font-medium text-kumo-inactive">
              Loading earlier messages…
            </div>
          )}

          {displayEntries.map(renderEntry)}

          {currentRowBuffer && currentHasUserDraftRows && (
            <DraftChangesRow
              rowBuffer={currentRowBuffer}
              isAgentActive={isAgentActive}
              previousEntry={lastEntry}
              onDiscardDraftChanges={handleDiscardDraftChanges}
              onFinalizeDraftChanges={handleFinalizeDraftChanges}
            />
          )}

          {isAgentActive && activeAgent && (
            <ProvisionalTurnRow
              provisionalState={currentProvisionalState}
              toolCalls={provisionalToolCalls}
              isCompacting={isCompacting}
              showThinkingTraces={showThinkingTraces}
              currentMessages={currentMessages}
              previousEntry={lastEntry}
              expandedToolCalls={expansion.toolCalls.keys}
              toggleToolCallExpansion={expansion.toolCalls.toggle}
            />
          )}

          {queuedSteers?.map((steer, index) => (
            <QueuedSteerRow
              key={index}
              text={steer.text}
              author={steer.author}
              showName={showsOwnUserName(steer.author.id)}
              groupedWithPrevious={
                steer.author.id === queuedSteers[index - 1]?.author.id
              }
              endsGroup={
                queuedSteers[index + 1]?.author.id !== steer.author.id
              }
              notReadYet={queuedSteers[index + 1] === undefined}
            />
          ))}
        </div>
      )}
    </>
  );
}

/**
 * The per-message dispatch: every message-shaped entry keeps one wrapper row (its
 * data-entry-key is what the scroller anchors and counts), with the message's own type
 * choosing the row that renders inside it. Everything else arrives as the same grouped
 * objects {@link ChatTranscript} takes, mapped onto each row's own props here.
 */
type MessageEntryRowProps = Pick<
  ChatTranscriptProps,
  | "isAgentActive"
  | "showThinkingTraces"
  | "restricted"
  | "lastMessageSequence"
  | "turnChanges"
  | "expansion"
  | "tools"
  | "actionCards"
  | "connections"
  | "errorHandling"
  | "messages"
> & {
  entry: Extract<ChatDisplayEntry, { type: "message" }>;
  entryTopClass: string;
  endsUserGroup: boolean;
  showsOwnUserName: (authorId: string) => boolean;
};

function MessageEntryRow({
  entry,
  entryTopClass,
  endsUserGroup,
  showsOwnUserName,
  isAgentActive,
  showThinkingTraces,
  restricted,
  lastMessageSequence,
  turnChanges,
  expansion,
  tools,
  actionCards,
  connections,
  errorHandling,
  messages,
}: MessageEntryRowProps) {
  const msg = entry.message;
  switch (msg.type) {
    case "slashCommand":
    case "message":
      if (msg.type === "message" && msg.author.type !== "user") {
        return (
          <div data-entry-key={entry.key} className={entryTopClass}>
            <AgentMessageRow
              msg={msg}
              workGroup={entry.workGroup}
              lastMessageSequence={entry.lastMessageSequence}
              showThinkingTraces={showThinkingTraces}
              isAgentActive={isAgentActive}
              lastDurablePendingChange={turnChanges.lastDurablePendingChange}
              pendingChangeByTurnItemSeq={turnChanges.pendingChangeByTurnItemSeq}
              createdWorkpiecesByTurnItemSeq={turnChanges.createdWorkpiecesByTurnItemSeq}
              completedAgentTurnMessageSeqs={turnChanges.completedAgentTurnMessageSeqs}
              latestCompletedAgentTurnMessageSeq={turnChanges.latestCompletedAgentTurnMessageSeq}
              expandedToolCalls={expansion.toolCalls.keys}
              toggleToolCallExpansion={expansion.toolCalls.toggle}
              resolveToolOutput={tools.resolveToolOutput}
              onOpenGadget={tools.onOpenGadget}
              onCopyMessage={messages.handleCopyMessage}
              onRevertChanges={turnChanges.handleRevertChanges}
            />
          </div>
        );
      }
      return (
        <div data-entry-key={entry.key} className={entryTopClass}>
          <UserMessageRow
            msg={msg}
            slashCommand={entry.slashCommand}
            endsUserGroup={endsUserGroup}
            showName={showsOwnUserName(msg.author.id)}
            getOverseer={tools.getOverseer}
            onDownloadAttachment={(chatId, attachment) => {
              void messages.downloadChatAttachment(chatId, attachment);
            }}
          />
        </div>
      );
    case "merge":
    case "revert":
      return (
        <div data-entry-key={entry.key} className={entryTopClass}>
          <MergeRevertRow
            msg={msg}
            timestamp={
              msg.type === "merge"
                ? messages.messageStates.mergeTimestamps.get(msg.sequence)
                : messages.messageStates.revertTimestamps.get(msg.sequence)
            }
          />
        </div>
      );
    case "action":
      return (
        <div data-entry-key={entry.key} className={entryTopClass}>
          <ActionCard
            msg={msg}
            restricted={!!restricted}
            open={expansion.actions.keys.has(msg.actionId)}
            isProcessing={actionCards.processingActions.has(msg.actionId)}
            onToggleExpansion={expansion.actions.toggle}
            onResolve={actionCards.resolveAction}
            onAlwaysApprove={actionCards.setAutoApproveConfirm}
            isTagAutoApproved={actionCards.isTagAutoApproved}
            onToggleHook={actionCards.handleToggleHook}
          />
        </div>
      );
    case "connectionRequest":
      return (
        <div data-entry-key={entry.key} className={entryTopClass}>
          <ConnectionRequestCard
            msg={msg}
            isProcessing={connections.processingConnections.has(msg.requestId)}
            onAccept={connections.handleAcceptConnection}
            onDeny={connections.handleDenyConnection}
          />
        </div>
      );
    case "useGadget":
      return (
        <div data-entry-key={entry.key} className={entryTopClass}>
          <div className="max-w-[860px] text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
            <Tooltip content={`Used the gadget at ${formatFullTimestamp(msg.timestamp)}`} asChild>
              <span className="inline-flex items-center gap-3 px-1.5 py-1">
                <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-kumo-inactive" aria-hidden="true">
                  <Plug size={16} />
                </span>
                <span>Used the gadget</span>
              </span>
            </Tooltip>
          </div>
        </div>
      );
    case "error": {
      const key = `${msg.chatId}-${msg.sequence}`;
      return (
        <div data-entry-key={entry.key} className={entryTopClass}>
          <ErrorRow
            msg={msg}
            isLast={msg.sequence === lastMessageSequence && !isAgentActive}
            isExpanded={expansion.errors.keys.has(key)}
            onToggle={() => expansion.errors.toggle(key)}
            onOpenUsageModal={() => errorHandling.setUsageModalOpen(true)}
            onRetry={() => void errorHandling.handleRetry()}
            retryModelId={errorHandling.retryModelId}
          />
        </div>
      );
    }
    case "agentCallback":
      return (
        <div data-entry-key={entry.key} className={entryTopClass}>
          <AgentCallbackRow msg={msg} />
        </div>
      );
    default:
      // "changes" and "catalogChange" never arrive as bare message entries (see
      // buildChatDisplayEntries); anything else renders its empty wrapper.
      return <div data-entry-key={entry.key} className={entryTopClass} />;
  }
}
