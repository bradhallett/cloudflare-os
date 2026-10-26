import { type ComponentProps } from "react";
import { Tooltip } from "@cloudflare/kumo";
import { Check } from "@phosphor-icons/react";
import { RpcStub } from "capnweb";
import {
  AiChatAuthorInfo,
  AiChatMetadata,
  BotInfo,
  BotSelection,
  Overseer,
} from "@gadgets/workshop-shared/api";
import { WorkshopButton } from "../../components/WorkshopControls";
import type { OverseerSource } from "../../components/chat/slash-command-catalog";
import { ChatComposer } from "./composer/ChatComposer";
import { composerDraftStorageKey } from "./composer/draft/composerDraft";
import { chatHasProposedChanges } from "./chatHasProposedChanges";
import { CONSTRAINED_CHAT_COLUMN_CLASS } from "./chatColumn";
import { DiscardPendingChangesPopover } from "./transcript/DiscardPendingChangesPopover";

type ComposerSend = ComponentProps<typeof ChatComposer>["onSend"];

/** Props for {@link ChatComposerBar}: the composer, its pending-changes banner, and cost row. */
export interface ChatComposerBarProps {
  sidebarMode: boolean | undefined;
  useConstrainedChatWidth: boolean | undefined;
  workspaceId: string | undefined;
  selectedChatId: number | null;
  overseer: RpcStub<Overseer>;
  getOverseer: OverseerSource;
  handleSend: ComposerSend;
  isAgentActive: boolean;
  availableModels: AiChatAuthorInfo[];
  selectedModel: string | null;
  /** The chat's own agent, so the picker can name a model it no longer offers. */
  chatAgent: AiChatAuthorInfo | null;
  handleModelChange: (modelId: string | null) => void;
  /** Declared bots offered in the in-chat composer's agent picker (see ComposerModelSelector). */
  bots: BotInfo[];
  /** The picker's bot selection, or null when a model or "No agent" answers the chat. */
  selectedBot: BotSelection | null;
  /** Chooses a bot in the agent picker; null returns to a bare model. */
  handleBotChange: (bot: BotSelection | null) => void;
  /** The chat's own bot name when that bot no longer resolves; shown as a disabled picker row. */
  staleBotName?: string;
  pendingConsoleLogCount: number;
  consoleLogPreview: string;
  consoleLogSeverity: "error" | "warn" | "info";
  onConsumeConsoleLogs: () => string;
  onDiscardConsoleLogs: () => void;
  handleStop: () => Promise<void>;
  queuedSteers: { text: string; author: AiChatAuthorInfo }[] | undefined;
  showThinkingTraces: boolean;
  toggleShowThinkingTraces: () => void;
  currentUser: AiChatAuthorInfo | null;
  hasPendingConnectionRequest: boolean;
  hasPendingAwaitedAction: boolean;
  /** The selected chat's metadata, undefined while it has not loaded. */
  currentChatMetadata: AiChatMetadata | null | undefined;
  hasPendingBlueprintProposal: boolean;
  discardingChangesChatIds: Set<number>;
  discardChangesTarget: { chatId: number } | null;
  setDiscardChangesTarget: (target: { chatId: number } | null) => void;
  handleDiscardPendingChanges: () => Promise<void>;
  handleAcceptChanges: () => Promise<void>;
}

/**
 * The chat's bottom block: the composer (with the pending-changes banner it can host and the
 * blocked reasons that gate sending), plus the token/cost summary row beneath it. Extracted
 * verbatim from ChatInterface; the composer's own state stays inside ChatComposer, remounted
 * per conversation by the key set here.
 */
export function ChatComposerBar({
  sidebarMode,
  useConstrainedChatWidth,
  workspaceId,
  selectedChatId,
  overseer,
  getOverseer,
  handleSend,
  isAgentActive,
  availableModels,
  selectedModel,
  chatAgent,
  handleModelChange,
  bots,
  selectedBot,
  handleBotChange,
  staleBotName,
  pendingConsoleLogCount,
  consoleLogPreview,
  consoleLogSeverity,
  onConsumeConsoleLogs,
  onDiscardConsoleLogs,
  handleStop,
  queuedSteers,
  showThinkingTraces,
  toggleShowThinkingTraces,
  currentUser,
  hasPendingConnectionRequest,
  hasPendingAwaitedAction,
  currentChatMetadata,
  hasPendingBlueprintProposal,
  discardingChangesChatIds,
  discardChangesTarget,
  setDiscardChangesTarget,
  handleDiscardPendingChanges,
  handleAcceptChanges,
}: ChatComposerBarProps) {
  return (
    <>
              {/* ── Bottom: input, update state, and cost ──────────────── */}
              <div className={`flex-shrink-0 bg-kumo-base ${sidebarMode ? "" : "border-t border-kumo-line"}`}>
                <div className={useConstrainedChatWidth ? CONSTRAINED_CHAT_COLUMN_CLASS : ""}>
                  {/* Remount all transient composer state when the conversation changes. */}
                  <ChatComposer
                    key={`${workspaceId}:${selectedChatId}`}
                    chatKey={selectedChatId}
                    createCapsuleGatekeeper={(accountId, url) =>
                      overseer.newGatekeeper(accountId, url)
                    }
                    getOverseer={getOverseer}
                    onSend={handleSend}
                    isAgentActive={isAgentActive}
                    models={availableModels}
                    selectedModel={selectedModel === null ? null : {
                      id: selectedModel,
                      name: chatAgent?.id === selectedModel ? chatAgent.name : undefined,
                    }}
                    onModelChange={handleModelChange}
                    bots={bots}
                    selectedBot={selectedBot}
                    onBotChange={handleBotChange}
                    showModels
                    staleBotName={staleBotName}
                    pendingConsoleLogCount={pendingConsoleLogCount}
                    consoleLogPreview={consoleLogPreview}
                    consoleLogSeverity={consoleLogSeverity}
                    onConsumeConsoleLogs={onConsumeConsoleLogs}
                    onDiscardConsoleLogs={onDiscardConsoleLogs}
                    onStop={handleStop}
                    queuedSteers={queuedSteers?.map((steer) => steer.text)}
                    showThinkingTraces={showThinkingTraces}
                    onToggleThinkingTraces={toggleShowThinkingTraces}
                    draftStorageKey={currentUser && workspaceId && selectedChatId !== null
                      ? composerDraftStorageKey(
                          currentUser.id,
                          `workspace:${workspaceId}:chat:${selectedChatId}`,
                        )
                      : undefined}
                    blockedReason={
                      hasPendingConnectionRequest
                        ? "Set up or deny the connection request above to continue."
                        : hasPendingAwaitedAction
                          ? "Approve or reject the pending action above to continue."
                          : undefined
                    }
                    draftUpdateBanner={(() => {
                      if (!currentChatMetadata ||
                          !(chatHasProposedChanges(currentChatMetadata) ||
                            hasPendingBlueprintProposal)) return null;

                      // Accepting always merges everything the chat proposes (drafts swept in,
                      // no partial accepts -- see Overseer.mergeChanges()), so the banner needs
                      // no accept cut of its own. Discard-all still uses sequence zero, which
                      // covers every batch including the compacted prefix's.
                      const isDiscardingChanges = discardingChangesChatIds.has(
                        currentChatMetadata.id,
                      );
                      const changesActionsDisabled = isAgentActive || isDiscardingChanges;
                      return (
                        <div className="themed-surface-inset relative flex items-center gap-2 overflow-hidden rounded-t-[calc(1rem-1px)] border-b border-kumo-line bg-kumo-elevated px-3.5 py-2">
                          <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-kumo-brand/40 to-transparent" aria-hidden="true" />
                          <span className="min-w-0 flex-1 truncate text-[12px] font-medium leading-4 tracking-[-0.2px] text-kumo-default">
                            Pending changes
                          </span>
                          <DiscardPendingChangesPopover
                            open={discardChangesTarget?.chatId === currentChatMetadata.id}
                            disabled={changesActionsDisabled}
                            isDiscarding={isDiscardingChanges}
                            onOpenChange={(open) => {
                              if (isDiscardingChanges) return;
                              setDiscardChangesTarget(open ? {
                                chatId: currentChatMetadata.id,
                              } : null);
                            }}
                            onConfirm={handleDiscardPendingChanges}
                          />
                          <Tooltip content={isAgentActive
                            ? "Wait for the agent to finish before accepting changes."
                            : isDiscardingChanges
                              ? "Wait for pending changes to finish discarding."
                              : "Keep this draft and make it the gadget's current version."} asChild>
                            <WorkshopButton
                              disabled={changesActionsDisabled}
                              onClick={() => { void handleAcceptChanges(); }}
                              tone="primary"
                              className="!h-7 !cursor-pointer !rounded-md !border-transparent !shadow-none gap-1 text-[12px]"
                            >
                              <Check size={11} weight="bold" />
                              Accept changes
                            </WorkshopButton>
                          </Tooltip>
                        </div>
                      );
                    })()}
                  />

                  {/* Token / cost summary. */}
                  <div className="-mt-1 flex min-h-[1.25rem] items-start justify-end gap-4 px-4 pb-1 font-mono text-[11px] leading-4 text-kumo-inactive">
                    {currentChatMetadata?.totalTokens != null && (
                      <span>
                        {currentChatMetadata.totalTokens.toLocaleString()} tokens
                      </span>
                    )}
                    {currentChatMetadata?.totalCost != null && (
                      <span>${currentChatMetadata.totalCost.toFixed(4)}</span>
                    )}
                  </div>
                </div>
              </div>
    </>
  );
}
