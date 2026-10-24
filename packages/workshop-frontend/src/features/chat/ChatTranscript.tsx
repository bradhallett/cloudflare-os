import { type ComponentProps } from "react";
import { Tooltip } from "@cloudflare/kumo";
import {
  ArrowUUpLeft,
  ArrowsClockwise,
  Brain,
  CaretRight,
  Check,
  Code,
  Copy,
  Lightning,
  Pencil,
  PencilSimple,
  Plug,
  Swap,
  WarningCircle,
} from "@phosphor-icons/react";
import {
  AiChatAuthorInfo,
  AiChatMessage,
  ChatAttachmentRef,
  WorkpieceId,
} from "@gadgets/workshop-shared/api";
import styles from "../../ChatInterface.module.css";
import { formatFullTimestamp } from "../../utils/formatTimestamp";
import { BlueprintProposalNotice } from "../blueprint-updates/BlueprintProposalNotice";
import { ChatAttachmentGrid } from "./attachments/ChatAttachmentGrid";
import { MarkdownMessage } from "./markdown/MarkdownMessage";
import {
  type ChangeChatMessage,
  createdWorkpiecesOf,
} from "./transcript/messageTypes";
import {
  getDiscardLabel,
  getSavedEditsDiscardLabel,
  type PendingTurnChanges,
} from "./transcript/pendingTurnChanges";
import {
  buildProvisionalToolSummary,
  getToolIcon,
  type ToolOutputResolver,
} from "./transcript/toolCalls";
import {
  continuesUserGroup,
  type ChatDisplayEntry,
  entryEndsInWorkRow,
  isUserMessageEntry,
  type MessageState,
} from "./transcript/chatDisplayEntries";
import {
  CreatedWorkpieceChatCard,
  type CreatedWorkpieceCardInfo,
} from "./transcript/CreatedWorkpieceChatCard";
import { ThinkingTraceRow } from "./transcript/ThinkingTraceRow";
import { ToolGroupRow } from "./transcript/ToolGroupRow";
import { ToolRunningIndicator } from "./transcript/ToolRunningIndicator";
import { SlashCommandMention } from "./transcript/SlashCommandMention";
import { ChatTranscriptEmptyState } from "./transcript/ChatTranscriptEmptyState";
import { FailedSendRow } from "./transcript/FailedSendRow";
import type { FailedChatSend } from "./transcript/failedSends";
import { WorkIcon } from "./transcript/WorkIcon";
import {
  ActionCard,
  type AutoApproveTarget,
} from "./transcript/ActionCard";
import { ConnectionRequestCard } from "./transcript/ConnectionRequestCard";
import type { OverseerSource } from "../../components/chat/slash-command-catalog";
import type {
  ChatChangeRowBuffer,
} from "./liveCodeStreams";
import type {
  ProvisionalChatState,
  ProvisionalToolCallState,
} from "./provisionalChatState";

type ActionCardResolve = ComponentProps<typeof ActionCard>["onResolve"];
type ConnectionAccept = ComponentProps<typeof ConnectionRequestCard>["onAccept"];

/** Props for {@link ChatTranscript}: everything the messages pane renders or calls. */
export interface ChatTranscriptProps {
  isLoading: boolean;
  isLoadingEarlier: boolean;
  pendingConsoleLogCount: number;
  useConstrainedChatWidth: boolean | undefined;
  displayEntries: ChatDisplayEntry[];
  entryTopClasses: string[];
  expandedCompactions: Set<number>;
  toggleCompactionSummary: (to: number) => void;
  currentUser: AiChatAuthorInfo | null;
  chatEpoch: number;
  isAgentActive: boolean;
  activeAgent: AiChatAuthorInfo | undefined;
  lastDurablePendingChange: ChangeChatMessage | null;
  pendingChangeByTurnItemSeq: Map<number, PendingTurnChanges>;
  createdWorkpiecesByTurnItemSeq: Map<number, CreatedWorkpieceCardInfo[]>;
  completedAgentTurnMessageSeqs: Set<number>;
  latestCompletedAgentTurnMessageSeq: number | null;
  resolveToolOutput: ToolOutputResolver;
  expandedToolCalls: Set<string>;
  toggleToolCallExpansion: (expansionKey: string) => void;
  onOpenGadget: (workpieceId: WorkpieceId) => void;
  getOverseer: OverseerSource;
  hideOwnUserName: boolean;
  downloadChatAttachment: (
    chatId: number,
    attachment: ChatAttachmentRef,
  ) => Promise<void>;
  showThinkingTraces: boolean;
  handleCopyMessage: (message: string) => Promise<void>;
  handleRevertChanges: (revertFrom: number) => Promise<void>;
  messageStates: MessageState;
  restricted: boolean | undefined;
  expandedActions: Set<number>;
  processingActions: Set<number>;
  toggleActionExpansion: (actionId: number) => void;
  resolveAction: ActionCardResolve;
  setAutoApproveConfirm: (target: AutoApproveTarget | null) => void;
  isTagAutoApproved: (gatekeeperId: number, tag: string) => boolean;
  handleToggleHook: (
    actionId: number,
    hookId: number,
    enabled: boolean,
  ) => Promise<void>;
  processingConnections: Set<string>;
  handleAcceptConnection: ConnectionAccept;
  handleDenyConnection: (requestId: string) => Promise<void>;
  expandedErrors: Set<string>;
  toggleErrorExpansion: (messageKey: string) => void;
  setUsageModalOpen: (open: boolean) => void;
  handleRetry: () => Promise<void>;
  /** The model a retry runs on — a bot chat retries on its bot's declared model, not the
   * composer's current pick (null disables the retry button). */
  retryModelId: string | null;
  lastMessageSequence: number | undefined;
  currentRowBuffer: ChatChangeRowBuffer | null;
  currentHasUserDraftRows: boolean;
  handleDiscardDraftChanges: () => Promise<void>;
  handleFinalizeDraftChanges: () => Promise<void>;
  currentProvisionalState: ProvisionalChatState | null;
  provisionalToolCalls: ProvisionalToolCallState[];
  isCompacting: boolean;
  /** Re-sends a failed user send's exact payload (the row's owner drops it on success). */
  onRetryFailedSend: (send: FailedChatSend) => void;
  /** Drops a failed user send's message for good. */
  onDismissFailedSend: (send: FailedChatSend) => void;
  currentMessages: AiChatMessage[];
  queuedSteers: { text: string; author: AiChatAuthorInfo }[] | undefined;
}

// The user's message bubble: rounded with the tail on the bottom right, markdown-aware.
const userBubbleClassName = `themed-user-bubble-shadow w-fit max-w-[min(680px,78%)] rounded-[24px] rounded-br-lg border border-transparent bg-kumo-bubble-user px-4 py-2.5 text-[14px] leading-[22px] tracking-[-0.25px] text-kumo-default ${styles.markdownContent}`;

/**
 * The messages pane inside the chat's scroll container: the loading spinner, the paged
 * history, one row per display entry, the live draft/agent placeholder, and queued steers.
 * Extracted verbatim from ChatInterface; the scroll container itself (and its earlier-page
 * prefetch) stays with the parent so scroll anchoring stays owned in one place.
 */
export function ChatTranscript({
  isLoading,
  isLoadingEarlier,
  pendingConsoleLogCount,
  useConstrainedChatWidth,
  displayEntries,
  entryTopClasses,
  expandedCompactions,
  toggleCompactionSummary,
  currentUser,
  chatEpoch,
  isAgentActive,
  activeAgent,
  lastDurablePendingChange,
  pendingChangeByTurnItemSeq,
  createdWorkpiecesByTurnItemSeq,
  completedAgentTurnMessageSeqs,
  latestCompletedAgentTurnMessageSeq,
  resolveToolOutput,
  expandedToolCalls,
  toggleToolCallExpansion,
  onOpenGadget,
  getOverseer,
  hideOwnUserName,
  downloadChatAttachment,
  showThinkingTraces,
  handleCopyMessage,
  handleRevertChanges,
  messageStates,
  restricted,
  expandedActions,
  processingActions,
  toggleActionExpansion,
  resolveAction,
  setAutoApproveConfirm,
  isTagAutoApproved,
  handleToggleHook,
  processingConnections,
  handleAcceptConnection,
  handleDenyConnection,
  expandedErrors,
  toggleErrorExpansion,
  setUsageModalOpen,
  handleRetry,
  retryModelId,
  lastMessageSequence,
  currentRowBuffer,
  currentHasUserDraftRows,
  handleDiscardDraftChanges,
  handleFinalizeDraftChanges,
  currentProvisionalState,
  provisionalToolCalls,
  isCompacting,
  currentMessages,
  onRetryFailedSend,
  onDismissFailedSend,
  queuedSteers,
}: ChatTranscriptProps) {
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
                    className={`flex flex-col px-3 pt-5 sm:px-6 sm:pt-8 ${pendingConsoleLogCount > 0 ? "pb-16" : "pb-8"} ${useConstrainedChatWidth ? "mx-auto w-full max-w-[920px]" : ""}`}
                  >
                    {displayEntries.length === 0 && !isAgentActive && (
                      <ChatTranscriptEmptyState />
                    )}

                    {isLoadingEarlier && (
                      <div className="mx-auto mb-6 text-[12px] leading-4 font-medium text-kumo-inactive">
                        Loading earlier messages…
                      </div>
                    )}

                    {displayEntries.map((entry, entryIndex) => {
                      const entryTopClass = entryTopClasses[entryIndex] ?? "";
                      if (entry.type === "compactionCut") {
                        // Only meaningful alongside the summary it belongs to, which is announced
                        // further down; on its own it would be a line with nothing to explain it.
                        if (!expandedCompactions.has(entry.boundary.to)) return null;
                        return (
                          <div key={entry.key} className={`${entryTopClass} mb-4 max-w-[860px]`}>
                            <div className="flex items-center gap-3" role="separator">
                              <span className="h-px flex-1 bg-kumo-line/60" aria-hidden="true" />
                              <span className="flex-shrink-0 text-[11px] leading-4 font-medium tracking-[0.6px] text-kumo-inactive uppercase">
                                Kept in full from here
                              </span>
                              <span className="h-px flex-1 bg-kumo-line/60" aria-hidden="true" />
                            </div>
                          </div>
                        );
                      }

                      if (entry.type === "compactionBoundary") {
                        const expanded = expandedCompactions.has(entry.boundary.to);
                        const kept = entry.keptRows;
                        const summary = (
                          <div className="themed-surface-inset mt-3 rounded-2xl border border-kumo-line/70 bg-kumo-elevated/45 p-3.5">
                            {kept !== undefined && (
                              // Says what the agent traded away and what it still has, since the
                              // marker sits at the request rather than at the cut it describes.
                              <p className="mb-3 text-[12px] leading-[17px] text-kumo-subtle">
                                The agent reads this in place of everything earlier in the chat.{" "}
                                {kept === 0
                                  ? "Nothing after it was kept."
                                  : `The ${kept === 1 ? "message" : `${kept} messages`} after the cut ${kept === 1 ? "was" : "were"} kept in full.`}
                              </p>
                            )}
                            <div className={`min-w-0 text-[13px] leading-[19px] ${styles.markdownContent}`}>
                              <MarkdownMessage message={entry.boundary.summary} />
                            </div>
                          </div>
                        );

                        // Announced at the user's request: an event where they asked, not a rule
                        // across the thread. The rule belongs at the cut, and appears there when
                        // this is opened.
                        if (entry.requestedBy) {
                          return (
                            <div key={entry.key} className={`${entryTopClass} max-w-[860px] py-1`}>
                              <button
                                type="button"
                                onClick={() => toggleCompactionSummary(entry.boundary.to)}
                                aria-expanded={expanded}
                                className="inline-flex cursor-pointer items-center gap-3 rounded-md px-1.5 text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none"
                              >
                                <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-kumo-inactive" aria-hidden="true">
                                  <Brain size={16} />
                                </span>
                                <span className="font-medium">
                                  {entry.requestedBy.name} compacted the context
                                </span>
                                <CaretRight
                                  size={11}
                                  weight="bold"
                                  className={`transition-transform duration-150 ease-out ${expanded ? "rotate-90" : ""}`}
                                />
                              </button>
                              {expanded && summary}
                            </div>
                          );
                        }

                        return (
                          <div key={entry.key} className={`${entryTopClass} mb-4 max-w-[860px]`}>
                            <div className="flex items-center gap-3" role="separator" aria-label="Context compacted">
                              <span className="h-px flex-1 bg-kumo-line" aria-hidden="true" />
                              <button
                                type="button"
                                onClick={() => toggleCompactionSummary(entry.boundary.to)}
                                aria-expanded={expanded}
                                className="flex flex-shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 text-[11px] leading-4 font-medium tracking-[0.6px] text-kumo-inactive uppercase transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none"
                              >
                                <Brain size={13} aria-hidden="true" />
                                Context compacted
                                <CaretRight
                                  size={11}
                                  weight="bold"
                                  className={`transition-transform duration-150 ease-out ${expanded ? "rotate-90" : ""}`}
                                />
                              </button>
                              <span className="h-px flex-1 bg-kumo-line" aria-hidden="true" />
                            </div>
                            {expanded && summary}
                          </div>
                        );
                      }

                      if (entry.type === "modelChange") {
                        return (
                          <div key={entry.key} className={`${entryTopClass} max-w-[860px] py-1 text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle`}>
                            <div className="flex items-center gap-3 px-1.5 py-1">
                              <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-kumo-inactive" aria-hidden="true">
                                <Swap size={16} />
                              </span>
                              <span className="min-w-0 truncate">
                                Switched to {entry.author.name}
                              </span>
                            </div>
                          </div>
                        );
                      }

                      if (entry.type === "savedChanges") {
                        const isOwnChange = entry.message.author.id === currentUser?.id;
                        const actor = isOwnChange ? "You" : entry.message.author.name;
                        // A user-authored creation is recorded as a "changes" message carrying
                        // createdGadgets over a no-op update, so label it as a creation rather
                        // than as saved edits.
                        const createdGadgets = entry.message.createdGadgets ?? [];
                        // An update-from-mainline batch merged other chats' accepted work into
                        // this draft (see Overseer.updateChatFromMainline()); label it as such,
                        // including how many files still carry conflict markers.
                        const mainlineMerge = entry.message.mainlineMerge;
                        const conflictCount = mainlineMerge?.conflictPaths.length ?? 0;
                        const label = mainlineMerge
                          ? `${actor} brought the gadget's latest changes into this draft${
                              conflictCount > 0
                                ? ` — ${conflictCount} ${conflictCount === 1 ? "file has" : "files have"} conflicts marked in the code`
                                : ""}`
                          : createdGadgets.length > 0
                          ? `${actor} created ${createdGadgets.length === 1 ? "gadget" : "gadgets"} ${
                              createdGadgets.map((g) => `“${g.title}”`).join(", ")}`
                          : `${actor} saved edits`;
                        // A mainline merge recorded before merges were commits can't be
                        // reverted while still proposed: it advanced the chat's pins with no
                        // record of where they were, and erasing it would let a later accept
                        // silently overwrite the mainline content it brought in (the server
                        // refuses too). One that records its `gadgets` puts the pins back.
                        const irrevocableMerge =
                          mainlineMerge !== undefined && mainlineMerge.gadgets === undefined;
                        const discardLabel = irrevocableMerge
                          ? "This update can't be discarded: it brought in changes already accepted elsewhere. Edit the files instead."
                          : mainlineMerge
                          ? entry.message.sequence === lastDurablePendingChange?.sequence
                            ? "Discard this update"
                            : "Discard this update and later changes"
                          : getSavedEditsDiscardLabel(
                              entry.message.sequence === lastDurablePendingChange?.sequence,
                              createdWorkpiecesOf(entry.message),
                            );
                        return (
                          <div key={entry.key} className={`${entryTopClass} group/savedChanges max-w-[860px] py-1 text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle`}>
                            <div className="flex items-center gap-3 px-1.5 py-1">
                              <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-kumo-inactive" aria-hidden="true">
                                <PencilSimple size={15} />
                              </span>
                              <span className="min-w-0 truncate font-medium">
                                {label}
                              </span>
                              <div className="flex flex-shrink-0 items-center gap-1 opacity-100 transition-opacity duration-150 ease-out sm:opacity-0 sm:group-hover/savedChanges:opacity-100 sm:group-focus-within/savedChanges:opacity-100">
                                {/* Edits from before the current epoch (i.e. before the chat's
                                    conversion to git-backed storage) can't be discarded
                                    individually -- only the banner's discard-all covers them. */}
                                {entry.message.sequence >= chatEpoch && (
                                <Tooltip content={discardLabel} asChild>
                                  <button
                                    type="button"
                                    disabled={isAgentActive || irrevocableMerge}
                                    onClick={() => handleRevertChanges(entry.message.sequence)}
                                    className="flex cursor-pointer items-center rounded-md p-1 text-kumo-inactive transition-[color,opacity,transform] duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
                                    aria-label={discardLabel}
                                  >
                                    <ArrowUUpLeft size={15} />
                                  </button>
                                </Tooltip>
                                )}
                                <Tooltip content={formatFullTimestamp(entry.message.timestamp)} asChild>
                                  <span className="px-1 font-mono text-[11px] leading-4 text-kumo-inactive">
                                    {entry.message.timestamp.toLocaleTimeString([], {
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

                      if (entry.type === "blueprintProposal") {
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
                      }

                      if (entry.type === "workRun") {
                        const pendingChange =
                          pendingChangeByTurnItemSeq.get(entry.lastMessageSequence) ?? null;
                        const createdWorkpieces =
                          createdWorkpiecesByTurnItemSeq.get(entry.lastMessageSequence) ?? [];
                        const showFooterOnGroupIndex = pendingChange
                          ? entry.toolCallGroups.length - 1
                          : -1;
                        return (
                          <div key={entry.key} className={`${entryTopClass} min-w-0 w-full max-w-[860px] space-y-2`}>
                            {entry.toolCallGroups.map((group, groupIndex) => (
                              <ToolGroupRow
                                outputOf={resolveToolOutput}
                                key={group.key}
                                group={group}
                                open={expandedToolCalls.has(group.key)}
                                expandedKeys={expandedToolCalls}
                                onToggle={toggleToolCallExpansion}
                                footerChangeSequence={
                                  groupIndex === showFooterOnGroupIndex
                                    ? pendingChange?.revertFrom
                                    : undefined
                                }
                                footerTimestamp={
                                  groupIndex === showFooterOnGroupIndex
                                    ? entry.lastMessageTimestamp
                                    : undefined
                                }
                                footerIsTrailing={
                                  pendingChange?.through === lastDurablePendingChange?.sequence
                                }
                                footerCreatedWorkpieces={
                                  groupIndex === showFooterOnGroupIndex
                                    ? pendingChange?.createdWorkpieces
                                    : undefined
                                }
                                footerDisabled={isAgentActive}
                                onFooterRevert={handleRevertChanges}
                              />
                            ))}
                            {createdWorkpieces.map((created) => (
                              <CreatedWorkpieceChatCard
                                key={created.workpieceId}
                                created={created}
                                onOpen={() => onOpenGadget(created.workpieceId)}
                              />
                            ))}
                          </div>
                        );
                      }

                      if (entry.type === "failedSend") {
                        return (
                          <div key={entry.key} className={entryTopClass}>
                            <FailedSendRow
                              send={entry.send}
                              getOverseer={getOverseer}
                              onRetry={onRetryFailedSend}
                              onDismiss={onDismissFailedSend}
                            />
                          </div>
                        );
                      }

                      const msg = entry.message;
                      const endsUserGroup = !continuesUserGroup(entry, displayEntries[entryIndex + 1]);

                      return (
                        <div key={entry.key} data-entry-key={entry.key} className={entryTopClass}>
                        {/* ── user / AI text message ── */}
                        {msg.type === "slashCommand" && (
                          <div className="group/message relative flex flex-col items-end">
                            <div className="themed-user-bubble-shadow w-fit max-w-[min(680px,78%)] rounded-[24px] rounded-br-lg border border-transparent bg-kumo-bubble-user px-4 py-2.5 text-[14px] leading-[22px] tracking-[-0.25px] text-kumo-default">
                              <span className="whitespace-pre-wrap">
                                <SlashCommandMention
                                  name={msg.skillName}
                                  args={msg.request.args}
                                  id={msg.request.id}
                                  commandPosition={msg.request.commandPosition}
                                  getOverseer={getOverseer}
                                />
                              </span>
                            </div>
                            {endsUserGroup && (
                              <div className="mt-0.5 flex items-center justify-end gap-2 pr-1 text-[11px] leading-4 text-kumo-inactive opacity-100 transition-opacity duration-150 ease-out sm:opacity-0 sm:group-hover/message:opacity-100 sm:group-focus-within/message:opacity-100">
                                {!(hideOwnUserName && msg.author.id === currentUser?.id) && (
                                  <span className="font-medium">{msg.author.name}</span>
                                )}
                                <Tooltip content={formatFullTimestamp(msg.timestamp)} asChild>
                                  <span className="font-mono">
                                    {msg.timestamp.toLocaleTimeString([], {
                                      hour: "2-digit",
                                      minute: "2-digit",
                                    })}
                                  </span>
                                </Tooltip>
                              </div>
                            )}
                          </div>
                        )}
                        {msg.type === "message" && (
                          msg.author.type === "user" ? (
                            <div className="group/message relative flex flex-col items-end">
                              <div className={userBubbleClassName}>
                                {msg.attachments && msg.attachments.length > 0 && (
                                  <ChatAttachmentGrid
                                    attachments={msg.attachments}
                                    onDownload={(attachment) => { void downloadChatAttachment(msg.chatId, attachment); }}
                                  />
                                )}
                                {entry.slashCommand ? (
                                  // What the command expanded into is the agent's context, not
                                  // something to re-read here.
                                  <div className="whitespace-pre-wrap">
                                    <SlashCommandMention
                                      name={entry.slashCommand.skillName}
                                      args={entry.slashCommand.request.args}
                                      id={entry.slashCommand.request.id}
                                      commandPosition={entry.slashCommand.request.commandPosition}
                                      formats={msg.formats}
                                      getOverseer={getOverseer}
                                    />
                                  </div>
                                ) : msg.message.trim() && (
                                  <MarkdownMessage
                                    message={msg.message}
                                    capsules={msg.capsules}
                                    formats={msg.formats}
                                    preserveLineBreaks
                                  />
                                )}
                              </div>
                              {endsUserGroup && (
                                <div className="mt-0.5 flex items-center justify-end gap-2 pr-1 text-[11px] leading-4 text-kumo-inactive opacity-100 transition-opacity duration-150 ease-out sm:opacity-0 sm:group-hover/message:opacity-100 sm:group-focus-within/message:opacity-100">
                                  {/* hideOwnUserName implies currentUser is non-null (see memo). */}
                                  {!(hideOwnUserName && msg.author.id === currentUser?.id) && (
                                    <span className="font-medium">{msg.author.name}</span>
                                  )}
                                  <Tooltip content={formatFullTimestamp(msg.timestamp)} asChild>
                                    <span className="font-mono">
                                      {msg.timestamp.toLocaleTimeString([], {
                                        hour: "2-digit",
                                        minute: "2-digit",
                                      })}
                                    </span>
                                  </Tooltip>
                                </div>
                              )}
                            </div>
                          ) : (() => {
                            const messageToolGroups = entry.toolCallGroups;
                            const hasMessageText = msg.message.trim().length > 0;
                            const showReasoning = showThinkingTraces && !!msg.reasoning;
                            const actionMessageSeq = entry.lastMessageSequence ?? msg.sequence;
                            const pendingChange = pendingChangeByTurnItemSeq.get(
                              actionMessageSeq,
                            ) ?? null;
                            const createdWorkpieces =
                              createdWorkpiecesByTurnItemSeq.get(actionMessageSeq) ?? [];
                            const attachActionsToToolGroups =
                              !hasMessageText &&
                              !!pendingChange &&
                              !!messageToolGroups &&
                              messageToolGroups.length > 0;
                            const showActions =
                              completedAgentTurnMessageSeqs.has(actionMessageSeq) &&
                              (hasMessageText || (!!pendingChange && !attachActionsToToolGroups));
                            const keepActionsVisible =
                              actionMessageSeq === latestCompletedAgentTurnMessageSeq;
                            const showFooterOnGroupIndex = attachActionsToToolGroups && pendingChange && messageToolGroups
                              ? messageToolGroups.length - 1
                              : -1;
                            return (
                          <div className="min-w-0 w-full max-w-[860px] space-y-2">
                            <div className="group/agentMessage relative space-y-1.5">
                              {showReasoning && (
                                <ThinkingTraceRow reasoning={msg.reasoning!} />
                              )}

                              {hasMessageText && (
                                <div className={`text-[14px] leading-[22px] tracking-[-0.25px] text-kumo-default ${styles.markdownContent}`}>
                                  <MarkdownMessage
                                    message={msg.message}
                                    capsules={msg.capsules}
                                    formats={msg.formats}
                                  />
                                </div>
                              )}

                              {showActions && (
                                <div className={`mt-0.5 -ml-1 flex items-center gap-1 transition-opacity duration-150 ease-out ${
                                  keepActionsVisible
                                    ? "opacity-100"
                                    : "opacity-100 sm:opacity-0 sm:group-hover/agentMessage:opacity-100 sm:group-focus-within/agentMessage:opacity-100"
                                }`}>
                                  {hasMessageText && (
                                    <Tooltip content="Copy message" asChild>
                                      <button
                                        type="button"
                                        onClick={() => handleCopyMessage(msg.message)}
                                        className="flex cursor-pointer items-center rounded-md p-1 text-kumo-inactive transition-[color,transform] duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.96]"
                                        aria-label="Copy message"
                                      >
                                        <Copy size={15} />
                                      </button>
                                    </Tooltip>
                                  )}
                                  {pendingChange && (() => {
                                    const label = getDiscardLabel(
                                      pendingChange.through === lastDurablePendingChange?.sequence,
                                      pendingChange.createdWorkpieces,
                                    );
                                    return (
                                    <Tooltip content={label} asChild>
                                      <button
                                        type="button"
                                        disabled={isAgentActive}
                                        onClick={() => handleRevertChanges(pendingChange.revertFrom)}
                                        className="flex cursor-pointer items-center rounded-md p-1 text-kumo-inactive transition-[color,opacity,transform] duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
                                        aria-label={label}
                                      >
                                        <ArrowUUpLeft size={15} />
                                      </button>
                                    </Tooltip>
                                    );
                                  })()}
                                  <Tooltip content={formatFullTimestamp(msg.timestamp)} asChild>
                                    <span className="px-1 font-mono text-[11px] leading-4 text-kumo-inactive">
                                      {msg.timestamp.toLocaleTimeString([], {
                                        hour: "2-digit",
                                        minute: "2-digit",
                                      })}
                                    </span>
                                  </Tooltip>
                                </div>
                              )}
                            </div>

                            {createdWorkpieces.map((created) => (
                              <CreatedWorkpieceChatCard
                                key={created.workpieceId}
                                created={created}
                                onOpen={() => onOpenGadget(created.workpieceId)}
                              />
                            ))}

                            {messageToolGroups && messageToolGroups.length > 0 && (
                              <div className="space-y-1">
                                {messageToolGroups.map((group, groupIndex) => (
                                  <ToolGroupRow
                                    outputOf={resolveToolOutput}
                                    key={group.key}
                                    group={group}
                                    open={expandedToolCalls.has(group.key)}
                                    expandedKeys={expandedToolCalls}
                                    onToggle={toggleToolCallExpansion}
                                    footerChangeSequence={
                                      groupIndex === showFooterOnGroupIndex
                                        ? pendingChange?.revertFrom
                                        : undefined
                                    }
                                    footerTimestamp={
                                      groupIndex === showFooterOnGroupIndex
                                        ? msg.timestamp
                                        : undefined
                                    }
                                    footerIsTrailing={
                                      pendingChange?.through === lastDurablePendingChange?.sequence
                                    }
                                    footerCreatedWorkpieces={
                                      groupIndex === showFooterOnGroupIndex
                                        ? pendingChange?.createdWorkpieces
                                        : undefined
                                    }
                                    footerDisabled={isAgentActive}
                                    onFooterRevert={handleRevertChanges}
                                  />
                                ))}
                              </div>
                            )}
                          </div>
                            );
                          })()
                        )}

                        {(msg.type === "merge" || msg.type === "revert") &&
                          (() => {
                            const isMerge = msg.type === "merge";
                            const ts = isMerge
                              ? messageStates.mergeTimestamps.get(msg.sequence)
                              : messageStates.revertTimestamps.get(
                                  msg.sequence,
                                );
                            return (
                              <div className="max-w-[860px] py-1 text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
                                <Tooltip
                                  content={
                                    isMerge
                                      ? `Accepted draft changes${ts ? ` through ${formatFullTimestamp(ts)}` : ""}.`
                                      : `Returned to the gadget state before the prompt sent ${ts ? `at ${ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "earlier"}.`
                                  }
                                  asChild
                                >
                                  <span className="inline-flex items-center gap-3 px-1.5">
                                    <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-kumo-inactive" aria-hidden="true">
                                      {isMerge ? <Check size={16} /> : <ArrowUUpLeft size={16} />}
                                    </span>
                                    <span className="font-medium">
                                      {msg.author.name}{" "}
                                      {isMerge
                                        ? "accepted changes"
                                        : "discarded changes"}
                                    </span>
                                  </span>
                                </Tooltip>
                              </div>
                            );
                          })()}

                        {msg.type === "action" && (
                          <ActionCard
                            msg={msg}
                            restricted={!!restricted}
                            open={expandedActions.has(msg.actionId)}
                            isProcessing={processingActions.has(msg.actionId)}
                            onToggleExpansion={toggleActionExpansion}
                            onResolve={resolveAction}
                            onAlwaysApprove={setAutoApproveConfirm}
                            isTagAutoApproved={isTagAutoApproved}
                            onToggleHook={handleToggleHook}
                          />
                        )}

                        {msg.type === "connectionRequest" && (
                          <ConnectionRequestCard
                            msg={msg}
                            isProcessing={processingConnections.has(msg.requestId)}
                            onAccept={handleAcceptConnection}
                            onDeny={handleDenyConnection}
                          />
                        )}

                        {msg.type === "useGadget" && (
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
                        )}

                        {msg.type === "error" &&
                          (() => {
                            const key = `${msg.chatId}-${msg.sequence}`;
                            const isLast =
                              msg.sequence === lastMessageSequence &&
                              !isAgentActive;
                            const expanded = expandedErrors.has(key);
                            return (
                              <div className="group/work max-w-[860px] text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
                                <div className="flex w-full items-center gap-2 px-1.5 py-1">
                                  <button
                                    type="button"
                                    onClick={() => toggleErrorExpansion(key)}
                                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md text-left transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.995]"
                                    aria-expanded={expanded}
                                  >
                                    <Tooltip content={formatFullTimestamp(msg.timestamp)} asChild>
                                      <span className="flex min-w-0 flex-1 items-center gap-2">
                                        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-kumo-danger" aria-hidden="true">
                                          <WarningCircle size={16} weight="fill" />
                                        </span>
                                        <span className="flex min-w-0 flex-1 items-center gap-1">
                                          <span className="min-w-0 truncate">
                                            <span className="font-medium text-kumo-danger">Error: </span>
                                            <span className="text-kumo-subtle">{msg.message}</span>
                                          </span>
                                          <CaretRight
                                            size={13}
                                            weight="bold"
                                            className={`flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out ${expanded ? "rotate-90" : ""}`}
                                          />
                                        </span>
                                      </span>
                                    </Tooltip>
                                  </button>
                                  {isLast && msg.code === "usage_limit" && (
                                    <Tooltip content="Add credits to continue." asChild>
                                      <button
                                        type="button"
                                        onClick={() => setUsageModalOpen(true)}
                                        className="flex flex-shrink-0 cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-[13px] leading-4 font-medium text-kumo-default transition-[color,opacity,transform] duration-150 ease-out hover:text-kumo-default-hover focus-visible:text-kumo-default-hover focus-visible:outline-none active:scale-[0.98]"
                                      >
                                        <Lightning size={12} weight="bold" />
                                        Continue
                                      </button>
                                    </Tooltip>
                                  )}
                                  {isLast && msg.code !== "usage_limit" && (
                                    <Tooltip content="Retry the last action." asChild>
                                      <button
                                        type="button"
                                        onClick={() => handleRetry()}
                                        disabled={retryModelId === null}
                                        className="flex flex-shrink-0 cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-[13px] leading-4 font-medium text-kumo-default transition-[color,opacity,transform] duration-150 ease-out hover:text-kumo-default-hover focus-visible:text-kumo-default-hover focus-visible:outline-none active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
                                      >
                                        <ArrowsClockwise size={12} weight="bold" />
                                        Retry
                                      </button>
                                    </Tooltip>
                                  )}
                                </div>
                                {expanded && (
                                  <div className="ml-8 mt-1">
                                    <pre className="max-h-48 overflow-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-3 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
                                      {msg.message}
                                    </pre>
                                  </div>
                                )}
                              </div>
                            );
                          })()}

                        {msg.type === "agentCallback" && (
                          <div className="max-w-[860px] text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
                            <Tooltip content={`Call received at ${formatFullTimestamp(msg.timestamp)}`} asChild>
                              <div className="flex items-center gap-3 px-1.5 py-1">
                                <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-kumo-inactive" aria-hidden="true">
                                  <Code size={16} />
                                </span>
                                <span className="min-w-0 truncate font-mono text-[13px]">
                                  {msg.methodName}()
                                </span>
                                {msg.bindingName !== undefined && (
                                  <span className="min-w-0 flex-shrink truncate font-mono text-[12px] leading-4 text-kumo-inactive">
                                    env.{msg.bindingName}
                                  </span>
                                )}
                              </div>
                            </Tooltip>
                            {msg.argsSummary && (
                              <div className="ml-8 mt-1">
                                <pre className="max-h-24 overflow-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-3 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
                                  {msg.argsSummary}
                                </pre>
                              </div>
                            )}
                          </div>
                        )}
                        </div>
                      );
                    })}

                    {currentRowBuffer && currentHasUserDraftRows && (() => {
                      const lastEditedAt = currentRowBuffer.lastUserEditAt;
                      const lastEntry = displayEntries[displayEntries.length - 1] ?? null;
                      const draftTopClass = !lastEntry
                        ? ""
                        : isUserMessageEntry(lastEntry)
                          ? "mt-6"
                          : entryEndsInWorkRow(lastEntry)
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
                                  onClick={handleDiscardDraftChanges}
                                  className="cursor-pointer rounded-md px-1 py-0.5 font-medium text-kumo-inactive transition-colors duration-150 ease-out hover:text-kumo-danger focus-visible:text-kumo-danger focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                  Discard
                                </button>
                              </Tooltip>
                              <Tooltip content="Save these edits as a draft version. They won't affect the gadget until you accept changes." asChild>
                                <button
                                  type="button"
                                  disabled={isAgentActive}
                                  onClick={handleFinalizeDraftChanges}
                                  className="cursor-pointer rounded-md px-1 py-0.5 font-medium text-kumo-default transition-[color,opacity,transform] duration-150 ease-out hover:text-kumo-default-hover focus-visible:text-kumo-default-hover focus-visible:outline-none active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                  Save draft
                                </button>
                              </Tooltip>
                            </div>
                          </div>
                        </div>
                      );
                    })()}

                    {isAgentActive && activeAgent && (() => {
                      // Placeholder shown only while the agent is active but hasn't produced
                      // visible output yet; once real output appears, that speaks for itself.
                      const hasShownReasoning =
                        showThinkingTraces && !!currentProvisionalState?.reasoning;
                      // Only while awaiting the agent's first output this turn; otherwise it
                      // flashes again in the gap after the last message finalizes but before
                      // isAgentActive clears.
                      const lastMessage =
                        currentMessages.length > 0
                          ? currentMessages[currentMessages.length - 1]
                          : null;
                      const awaitingFirstResponse =
                        !lastMessage ||
                        lastMessage.author.type === "user" ||
                        lastMessage.author.type === "gadget";
                      const showThinking =
                        !isCompacting &&
                        awaitingFirstResponse &&
                        !currentProvisionalState?.text &&
                        !hasShownReasoning &&
                        provisionalToolCalls.length === 0;

                      // Match the spacing this response gets once finalized (see rhythmTopClass)
                      // so it doesn't shift when streaming completes.
                      const lastEntry =
                        displayEntries.length > 0
                          ? displayEntries[displayEntries.length - 1]
                          : null;
                      const provisionalTopClass = !lastEntry
                        ? ""
                        : lastEntry.type === "modelChange"
                          ? "mt-2"
                          : isUserMessageEntry(lastEntry)
                            ? "mt-5"
                            : "mt-4";

                      return (
                        <div className={`group/agent min-w-0 w-full max-w-[860px] space-y-2 ${provisionalTopClass}`}>
                          {isCompacting && (
                            <div className="inline-flex shimmer px-1.5 py-1 text-[14px] leading-5 tracking-[-0.25px] text-kumo-inactive shimmer-duration-1800">
                              Compacting…
                            </div>
                          )}

                          {showThinking && (
                            <div className="inline-flex shimmer px-1.5 py-1 text-[14px] leading-5 tracking-[-0.25px] text-kumo-inactive shimmer-duration-1800">
                              Thinking
                            </div>
                          )}

                          {showThinkingTraces && currentProvisionalState?.reasoning && (
                            <ThinkingTraceRow reasoning={currentProvisionalState.reasoning} />
                          )}

                          {currentProvisionalState?.text && (
                            <div className={`text-[14px] leading-[22px] tracking-[-0.25px] text-kumo-default ${styles.markdownContent}`}>
                              <MarkdownMessage message={currentProvisionalState.text} />
                            </div>
                          )}

                          {provisionalToolCalls.length > 0 && (() => {
                            const first = provisionalToolCalls[0];
                            const { label, detailLines, running } =
                              buildProvisionalToolSummary(provisionalToolCalls);
                            const expansionKey = `group-${first.toolCallId}`;
                            const isExpanded = expandedToolCalls.has(expansionKey);
                            const detailCalls = provisionalToolCalls.filter(
                              (t) => t.code || t.output,
                            );
                            return (
                              <div className="space-y-1">
                                <div className="group/work -ml-0.5">
                                  <button
                                    type="button"
                                    onClick={() => toggleToolCallExpansion(expansionKey)}
                                    className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-1.5 py-1 text-left text-kumo-subtle transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.995]"
                                    aria-expanded={isExpanded}
                                  >
                                    <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
                                      <WorkIcon Icon={getToolIcon(first.toolName, first.outputFormat)} />
                                    </span>
                                    <span className="min-w-0 flex-1">
                                      <span className="flex min-w-0 items-center gap-2 text-[14px] leading-5 tracking-[-0.25px]">
                                        <span className="min-w-0 truncate">{label}</span>
                                        {running && <ToolRunningIndicator />}
                                        <CaretRight
                                          size={13}
                                          weight="bold"
                                          className={`flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out ${isExpanded ? "rotate-90" : ""}`}
                                        />
                                      </span>
                                      {detailLines.length > 1 && (
                                        <span className="mt-1 block truncate font-mono text-[12px] leading-4 text-kumo-inactive">
                                          {detailLines.join(" · ")}
                                        </span>
                                      )}
                                    </span>
                                  </button>
                                  {isExpanded && detailCalls.length > 0 && (
                                    <div className="ml-8 mt-1 space-y-1">
                                      {detailCalls.map((toolCall) => (
                                        <div
                                          key={`stream-tool-${toolCall.toolCallId}`}
                                          className="themed-surface-inset space-y-3 rounded-2xl border border-kumo-line/70 bg-kumo-elevated/45 p-3"
                                        >
                                          {toolCall.code && (
                                            <>
                                              <span className="font-mono text-[11px] leading-4 text-kumo-inactive uppercase tracking-[0.08em]">Code</span>
                                              <pre className="max-h-56 overflow-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-3 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
                                                {toolCall.code}
                                              </pre>
                                            </>
                                          )}
                                          {toolCall.output && (
                                            <>
                                              <span className="font-mono text-[11px] leading-4 text-kumo-inactive uppercase tracking-[0.08em]">Output</span>
                                              <pre className="max-h-56 overflow-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-3 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
                                                {toolCall.output}
                                              </pre>
                                            </>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })()}
                        </div>
                      );
                    })()}
                    {queuedSteers?.map((steer, index) => {
                      const sameAuthorAsPrevious = steer.author.id === queuedSteers[index - 1]?.author.id;
                      const next = queuedSteers[index + 1];
                      return (
                        <div key={index} className={`flex flex-col items-end ${sameAuthorAsPrevious ? "mt-2" : "mt-5"}`}>
                          <div className={`${userBubbleClassName} opacity-60`}>
                            <MarkdownMessage message={steer.text} preserveLineBreaks />
                          </div>
                          {next?.author.id !== steer.author.id && (
                            <div className="mt-1 flex items-center justify-end gap-2 pr-1 text-[11px] leading-4 text-kumo-inactive">
                              {!(hideOwnUserName && steer.author.id === currentUser?.id) && (
                                <span className="font-medium">{steer.author.name}</span>
                              )}
                              {!next && <span>Not read yet</span>}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
    </>
  );
}
