import { useMemo, type ComponentProps } from "react";
import { DropdownMenu, Tooltip } from "@cloudflare/kumo";
import {
  CaretDown,
  Check,
  DotsThreeVertical,
  Pencil,
  Robot,
  Trash,
} from "@phosphor-icons/react";
import { RpcStub } from "capnweb";
import {
  Overseer,
  AiChatAuthorInfo,
  AiChatMetadata,
  BotInfo,
  BotSelection,
} from "@gadgets/workshop-shared/api";
import { WorkshopIconButton } from "../../components/WorkshopControls";
import { isImeComposing } from "../../keyboardEvent";
import type { useAuthenticatedApi } from "../../AuthContext";
import { ChatComposer } from "./composer/ChatComposer";
import { composerDraftStorageKey } from "./composer/draft/composerDraft";
import { chatHasProposedChanges } from "./chatHasProposedChanges";
import { CONSTRAINED_CHAT_COLUMN_CLASS } from "./chatColumn";

type ChatComposerProps = ComponentProps<typeof ChatComposer>;
/** Which chats the sidebar list shows: everyone's, only people's, or only agents'. */
export type ChatListScope = "direct" | "agents" | "all";

const CHAT_LIST_SCOPE_LABELS: Record<ChatListScope, string> = {
  all: "All",
  direct: "Started by people",
  agents: "Started by agents",
};

// Bucket a chat's lastActive into a time grouping for the chat list.
type ChatTimeBucket = "today" | "yesterday" | "thisWeek" | "earlier";

const CHAT_TIME_BUCKET_LABELS: Record<ChatTimeBucket, string> = {
  today: "Today",
  yesterday: "Yesterday",
  thisWeek: "Earlier this week",
  earlier: "Earlier",
};
const CHAT_TIME_BUCKET_ORDER: ChatTimeBucket[] = [
  "today",
  "yesterday",
  "thisWeek",
  "earlier",
];

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function getChatTimeBucket(date: Date, now: Date): ChatTimeBucket {
  const diffDays = Math.round(
    (startOfDay(now).getTime() - startOfDay(date).getTime()) / 86_400_000,
  );
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return "thisWeek";
  return "earlier";
}

// Format a chat's lastActive for display in a row, given its bucket. Buckets
// own the "date" half of the label (via the section header), so rows only show
// what the header doesn't.
function formatChatRowTime(date: Date, bucket: ChatTimeBucket, now: Date): string {
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (bucket === "today" || bucket === "yesterday") {
    return time;
  }
  if (bucket === "thisWeek") {
    const day = date.toLocaleDateString([], { weekday: "short" });
    return `${day} ${time}`;
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(
    [],
    sameYear
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" },
  );
}

/** Props {@link ChatListPanel} reads from its host. */
export interface ChatListPanelProps {
  chatList: readonly AiChatMetadata[];
  chatListScope: ChatListScope;
  setChatListScope: (scope: ChatListScope) => void;
  chatListReady: boolean;
  sidebarMode: boolean | undefined;
  selectedChatId: number | null;
  onNavigateToChat: (
    chatId: number | null,
    options?: { replace?: boolean },
  ) => void;
  renamingChatId: number | null;
  renamingInput: string;
  setRenamingInput: (value: string) => void;
  startListRename: (chatId: number, title: string) => void;
  cancelListRename: () => void;
  handleSaveListRename: (chatId: number) => Promise<void>;
  handleDeleteChat: (chatId?: number, chatTitle?: string) => void;
  useConstrainedChatWidth: boolean | undefined;
  workspaceId: string | undefined;
  overseer: RpcStub<Overseer>;
  getOverseer: () => RpcStub<Overseer>;
  currentUser: ReturnType<typeof useAuthenticatedApi>["currentUser"];
  availableModels: readonly AiChatAuthorInfo[];
  selectedModel: string | null;
  handleModelChange: (modelId: string | null) => void;
  /** Declared bots offered in the intake composer's agent picker (see ComposerModelSelector). */
  bots: BotInfo[];
  /** The intake picker's bot selection, or null when a model or "No agent" answers. */
  selectedBot: BotSelection | null;
  /** Chooses a bot in the intake picker; null returns to a bare model. */
  handleBotChange: (bot: BotSelection | null) => void;
  showThinkingTraces: boolean;
  toggleShowThinkingTraces: () => void;
  handleNewChatSend: ChatComposerProps["onSend"];
}

/**
 * The conversations sidebar: the scope-filtered, time-bucketed chat list with
 * inline rename/delete, plus the new-chat composer pinned to its bottom.
 * Behavior moved verbatim from ChatInterface.
 */
export function ChatListPanel({
  chatList,
  chatListScope,
  setChatListScope,
  chatListReady,
  sidebarMode,
  selectedChatId,
  onNavigateToChat,
  renamingChatId,
  renamingInput,
  setRenamingInput,
  startListRename,
  cancelListRename,
  handleSaveListRename,
  handleDeleteChat,
  useConstrainedChatWidth,
  workspaceId,
  overseer,
  getOverseer,
  currentUser,
  availableModels,
  selectedModel,
  handleModelChange,
  bots,
  selectedBot,
  handleBotChange,
  showThinkingTraces,
  toggleShowThinkingTraces,
  handleNewChatSend,
}: ChatListPanelProps) {
  const {
    visibleChatList,
    chatListNow,
    bucketedVisibleChats,
    chatListScopes,
  } = useMemo(() => {
    const directCount = chatList.filter((chat) => !chat.spawnerName).length;
    const agentCount = chatList.length - directCount;
    const visible = chatList.filter((chat) => {
      if (chatListScope === "direct") return !chat.spawnerName;
      if (chatListScope === "agents") return Boolean(chat.spawnerName);
      return true;
    });
    const now = new Date();
    const buckets = new Map<ChatTimeBucket, AiChatMetadata[]>();
    for (const chat of visible) {
      const bucket = getChatTimeBucket(chat.lastActive, now);
      let arr = buckets.get(bucket);
      if (!arr) {
        arr = [];
        buckets.set(bucket, arr);
      }
      arr.push(chat);
    }

    return {
      visibleChatList: visible,
      chatListNow: now,
      bucketedVisibleChats: CHAT_TIME_BUCKET_ORDER.flatMap((bucket) => {
        const items = buckets.get(bucket);
        if (!items || items.length === 0) return [];
        return [{ bucket, items }];
      }),
      chatListScopes: [
        { value: "all" as const, count: chatList.length },
        { value: "direct" as const, count: directCount },
        { value: "agents" as const, count: agentCount },
      ],
    };
  }, [chatList, chatListScope]);

  const chatListPanel = (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Chat list header — title doubles as the scope switcher */}
      <div className="flex h-12 flex-shrink-0 items-center border-b border-kumo-line px-4">
        <DropdownMenu>
          <DropdownMenu.Trigger
            render={
              <button
                type="button"
                className="group flex h-8 -ml-1.5 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-left transition-colors duration-150 ease-out hover:bg-kumo-tint/60 focus-visible:bg-kumo-tint/60 focus-visible:outline-none data-[popup-open]:bg-kumo-tint/60"
                aria-label="Filter conversations"
              >
                <span className="text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                  {CHAT_LIST_SCOPE_LABELS[chatListScope]}
                </span>
                <CaretDown
                  size={10}
                  weight="bold"
                  className="text-kumo-inactive transition-transform duration-150 ease-out group-data-[popup-open]:rotate-180"
                />
              </button>
            }
          />
          <DropdownMenu.Content className="themed-floating-shadow !z-[1100] !min-w-[200px] rounded-lg border border-kumo-line bg-kumo-base p-1">
            {chatListScopes.map((scope) => {
              const active = chatListScope === scope.value;
              return (
                <DropdownMenu.Item
                  key={scope.value}
                  onClick={() => setChatListScope(scope.value)}
                  className="!h-auto rounded-md !px-2.5 !py-1.5 text-[12px] leading-4 tracking-[-0.2px] text-kumo-default transition-colors data-highlighted:bg-kumo-tint"
                >
                  <span className="mr-2 inline-flex h-3 w-3 items-center justify-center text-kumo-default">
                    {active ? <Check size={11} weight="bold" /> : null}
                  </span>
                  <span className="flex-1">{CHAT_LIST_SCOPE_LABELS[scope.value]}</span>
                  <span className="ml-3 font-mono text-[11px] text-kumo-inactive">
                    {scope.count}
                  </span>
                </DropdownMenu.Item>
              );
            })}
          </DropdownMenu.Content>
        </DropdownMenu>
      </div>
      {/* Chat list */}
      <div className="chat-panel flex-1 overflow-y-auto bg-kumo-base p-3">
        {!chatListReady ? (
          <div className="flex items-center justify-center py-10">
            <div className="w-5 h-5 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
          </div>
        ) : chatList.length === 0 ? (
          <p className="text-sm text-kumo-inactive text-center py-8">
            No conversations yet
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {visibleChatList.length === 0 ? (
              // Only reachable when a non-"all" scope filters everything out;
              // the all-empty case is handled by the outer chatList.length check.
              <div className="py-8 text-center">
                <p className="text-[13px] leading-[18px] text-kumo-inactive">
                  No conversations started by {chatListScope === "agents" ? "agents" : "people"} yet
                </p>
                <button
                  type="button"
                  onClick={() => setChatListScope("all")}
                  className="mt-2 cursor-pointer rounded-md px-2 py-1 text-[12px] leading-4 font-medium text-kumo-subtle transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none"
                >
                  Show all
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {bucketedVisibleChats.map(({ bucket, items }) => (
                  <section key={bucket} className="flex flex-col gap-0.5">
                    <p className="mb-1 px-1 text-[11px] font-medium uppercase tracking-[0.08em] text-kumo-inactive">
                      {CHAT_TIME_BUCKET_LABELS[bucket]}
                    </p>
                    {items.map((chat) => (
              <div key={chat.id} className="relative">
                {(() => {
                  const isRenaming = renamingChatId === chat.id;
                  return (
                  <div
                    onClick={isRenaming ? undefined : () => onNavigateToChat(chat.id)}
                    className={`group flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-[background-color] duration-150 ease-out ${
                      isRenaming
                        ? "cursor-default bg-kumo-base ring-1 ring-kumo-ring/40"
                        : sidebarMode && chat.id === selectedChatId
                          ? "cursor-pointer bg-kumo-recessed"
                          : "cursor-pointer hover:bg-kumo-tint"
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        {isRenaming ? (
                          <input
                            type="text"
                            value={renamingInput}
                            onChange={(e) => setRenamingInput(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              if (isImeComposing(e)) return;
                              if (e.key === "Enter") {
                                e.preventDefault();
                                handleSaveListRename(chat.id);
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                cancelListRename();
                              }
                            }}
                            onBlur={() => handleSaveListRename(chat.id)}
                            autoFocus
                            spellCheck={false}
                            autoCapitalize="off"
                            autoCorrect="off"
                            aria-label={`Rename ${chat.title}`}
                            className="min-w-0 flex-1 bg-transparent text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default outline-none placeholder:text-kumo-inactive"
                          />
                        ) : (
                          <span className="truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                            {chat.title}
                          </span>
                        )}
                        {!isRenaming && chat.activeAgent ? (
                          <span className="inline-flex shimmer flex-shrink-0 cursor-pointer items-center gap-1 text-[11px] leading-4 font-medium text-kumo-brand">
                            <span className="h-1.5 w-1.5 rounded-full bg-kumo-brand" />
                            Working
                          </span>
                        ) : !isRenaming && chatHasProposedChanges(chat) ? (
                          <Tooltip content="This conversation has pending changes" asChild>
                            <span className="inline-flex flex-shrink-0 cursor-pointer items-center gap-1 text-[11px] leading-4 font-medium text-kumo-warning">
                              <span className="h-1.5 w-1.5 rounded-full bg-kumo-warning" />
                              Pending changes
                            </span>
                          </Tooltip>
                        ) : null}
                      </div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-kumo-inactive">
                        {chat.spawnerName && (
                          <>
                            <span className="truncate">Agent · {chat.spawnerName}</span>
                            <span className="flex-shrink-0" aria-hidden="true">·</span>
                          </>
                        )}
                        {chat.botName && (
                          <>
                            <span className="truncate inline-flex min-w-0 items-center gap-1">
                              <Robot size={11} weight="fill" className="flex-shrink-0" />
                              <span className="truncate">{chat.botName}</span>
                            </span>
                            <span className="flex-shrink-0" aria-hidden="true">·</span>
                          </>
                        )}
                        <span className="flex-shrink-0">
                          {formatChatRowTime(chat.lastActive, bucket, chatListNow)}
                        </span>
                        {chat.totalCost != null && (
                          <>
                            <span className="flex-shrink-0" aria-hidden="true">·</span>
                            <span className="flex-shrink-0 font-mono">
                              ${chat.totalCost.toFixed(4)}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    {!isRenaming && (
                      <DropdownMenu>
                        <DropdownMenu.Trigger
                          render={
                            <WorkshopIconButton
                              aria-label={`Actions for ${chat.title}`}
                              onClick={(e) => e.stopPropagation()}
                              className="!h-9 !w-9 flex-shrink-0 text-kumo-inactive opacity-100 focus:opacity-100 group-hover:opacity-100 data-[popup-open]:opacity-100 sm:!h-7 sm:!w-7 sm:opacity-0"
                            >
                              <DotsThreeVertical size={14} />
                            </WorkshopIconButton>
                          }
                        />
                        <DropdownMenu.Content
                          onClick={(event) => event.stopPropagation()}
                          className="themed-floating-shadow !z-[1100] !min-w-[144px] rounded-lg border border-kumo-line bg-kumo-base p-1"
                        >
                          <DropdownMenu.Item
                            icon={<Pencil size={12} className="mr-2" />}
                            onClick={() => startListRename(chat.id, chat.title)}
                            className="!h-auto rounded-md !px-2.5 !py-1.5 text-[12px] leading-4 tracking-[-0.2px] text-kumo-default transition-colors data-highlighted:bg-kumo-tint"
                          >
                            Rename
                          </DropdownMenu.Item>
                          <DropdownMenu.Item
                            icon={<Trash size={12} className="mr-2" />}
                            variant="danger"
                            onClick={() => handleDeleteChat(chat.id, chat.title)}
                            className="!h-auto rounded-md !px-2.5 !py-1.5 text-[12px] leading-4 tracking-[-0.2px] transition-colors data-highlighted:bg-kumo-danger-tint"
                          >
                            Delete
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu>
                    )}
                  </div>
                  );
                })()}
              </div>
                    ))}
                  </section>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* New chat input — pinned to bottom. ChatComposer supplies its own
          horizontal padding, so the wrapper just adds the top divider; no
          extra p-4 (which would shrink the input vs. the in-chat composer). */}
      <div className="flex-shrink-0 border-t border-kumo-line">
        <div className={useConstrainedChatWidth ? CONSTRAINED_CHAT_COLUMN_CLASS : ""}>
          {/* Attachments and pending resource operations belong to this workspace's composer. */}
          <ChatComposer
            key={workspaceId}
            createCapsuleGatekeeper={(accountId, url) =>
              overseer.newGatekeeper(accountId, url)
            }
            getOverseer={getOverseer}
            onSend={handleNewChatSend}
            isAgentActive={false}
            models={availableModels}
            selectedModel={selectedModel === null ? null : { id: selectedModel }}
            defaultModelId={selectedModel ?? availableModels[0]?.id ?? null}
            onModelChange={handleModelChange}
            bots={bots}
            selectedBot={selectedBot}
            onBotChange={handleBotChange}
            showThinkingTraces={showThinkingTraces}
            onToggleThinkingTraces={toggleShowThinkingTraces}
            minRows={2}
            newChat
            draftStorageKey={currentUser && workspaceId
              ? composerDraftStorageKey(currentUser.id, `workspace:${workspaceId}:new`)
              : undefined}
          />
          {/* Reserve the same height as the token/cost row to avoid layout shift. */}
          <div aria-hidden className="min-h-[1rem]" />
        </div>
      </div>
    </div>
  );

  return chatListPanel;
}
