import { DropdownMenu } from "@cloudflare/kumo";
import { CaretDown, Check } from "@phosphor-icons/react";
import type { AiChatAuthorInfo, BotInfo, BotSelection } from "@gadgets/workshop-shared/api";
import { sameBotSelection } from "../../../modelSelection";

/**
 * The composer's model, or null for "No agent". `name` labels it when `models` doesn't offer it,
 * such as a hidden model an existing chat last ran on; the raw id is shown when that is absent too.
 */
export type SelectedModel = { id: string; name?: string } | null;

type ComposerModelSelectorProps = {
  models: readonly AiChatAuthorInfo[];
  selectedModel: SelectedModel;
  onModelChange: (modelId: string | null) => void;
  /** Bots offered above the models. Empty (or with no `onBotChange`) hides the group. */
  bots?: readonly BotInfo[];
  /** The bot the picker selects; null when a model or "No agent" answers the chat. */
  selectedBot?: BotSelection | null;
  onBotChange?: (bot: BotSelection | null) => void;
  /**
   * Whether the raw model list is offered. In-chat composers set it: there the picker is a single
   * choice of who answers, so a bare model is a real alternative to a bot. Intake composers leave
   * it off and offer the default model as "Default agent" instead — model tuning happens in chat.
   */
  showModels?: boolean;
  /**
   * The intake row's model id: the caller's stored selection (see getStoredSelectedModel),
   * falling back to the first model. Read from a prop rather than storage so the row stays
   * pure; only the intake callers (showModels off) need it.
   */
  defaultModelId?: string | null;
  /**
   * The chat's own bot name when that bot no longer resolves in `bots` (deleted, or removed from
   * the deployment). Shown as a disabled row so the chat's state is legible while its sends fall
   * back to bare-model sends.
   */
  staleBotName?: string;
};
const menuEyebrowClass =
  "px-2 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-[0.06em] text-kumo-inactive";
const menuItemClass =
  "!h-auto rounded-xl !px-2 !py-1.5 text-[12px] leading-4 font-normal tracking-[-0.15px] text-kumo-subtle transition-colors data-highlighted:bg-kumo-tint/70 data-highlighted:text-kumo-default";

export const ComposerModelSelector = ({
  models,
  selectedModel,
  onModelChange,
  bots,
  selectedBot,
  onBotChange,
  showModels = false,
  defaultModelId = null,
  staleBotName,
}: ComposerModelSelectorProps) => {
  const botRows = onBotChange != null && (bots == null || bots.length > 0 || staleBotName != null);
  const selectedBotInfo = bots?.find((bot) =>
    selectedBot != null && sameBotSelection(bot.selection, selectedBot));

  const defaultModelName = defaultModelId === null
    ? undefined
    : models.find((model) => model.id === defaultModelId)?.name ?? defaultModelId;

  const selectedModelLabel = selectedModel == null
    ? "No agent"
    : models.find((model) => model.id === selectedModel.id)?.name ??
      selectedModel.name ?? selectedModel.id;
  const selectedLabel = selectedBotInfo?.name ?? selectedModelLabel;

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <button
            type="button"
            className="group inline-flex h-10 min-w-0 max-w-[110px] cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[14px] leading-5 text-kumo-subtle transition-[background-color,color,transform] duration-150 ease-out hover:bg-kumo-tint hover:text-kumo-default focus-visible:bg-kumo-tint focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.97] data-[popup-open]:bg-kumo-tint data-[popup-open]:text-kumo-default sm:h-8 sm:max-w-[180px] sm:text-[13px]"
            aria-label="Select agent"
          >
            <span className="min-w-0 truncate">{selectedLabel}</span>
            <CaretDown
              size={12}
              weight="bold"
              className="flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out group-data-[popup-open]:rotate-180"
            />
          </button>
        }
      />
      <DropdownMenu.Content className="themed-floating-shadow-lg !z-[1100] !min-w-[230px] rounded-2xl border border-kumo-line/70 bg-kumo-base p-1">
        {botRows && (
          <>
            <p className={menuEyebrowClass}>Bots</p>
            {staleBotName != null && (
              <DropdownMenu.Item
                disabled
                className={`${menuItemClass} opacity-50`}
              >
                <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                  <span className="w-full min-w-0 truncate">{staleBotName}</span>
                  <span className="w-full min-w-0 truncate text-[11px] leading-[14px] text-kumo-inactive">
                    No longer available
                  </span>
                </span>
              </DropdownMenu.Item>
            )}
            {bots?.map((bot) => {
              const active = selectedBot != null && sameBotSelection(bot.selection, selectedBot);
              return (
                <DropdownMenu.Item
                  key={`${bot.selection.scope}:${bot.selection.id}`}
                  disabled={!bot.available}
                  onClick={() => onBotChange?.(bot.selection)}
                  className={`${menuItemClass} cursor-pointer`}
                >
                  <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                    <span className="w-full min-w-0 truncate text-kumo-default">{bot.name}</span>
                    <span className="w-full min-w-0 truncate text-[11px] leading-[14px] text-kumo-inactive">
                      {bot.available
                        ? bot.modelName ?? bot.modelId
                        // Refuse-visibly, in the picker too: a bot whose model no longer resolves
                        // stays listed (disabled, with its reason) rather than vanishing.
                        : bot.unavailableReason ?? "Not available"}
                    </span>
                  </span>
                  {active && (
                    <Check
                      size={12}
                      weight="bold"
                      className="ml-3 flex-shrink-0 text-kumo-inactive"
                    />
                  )}
                </DropdownMenu.Item>
              );
            })}
            <div className="my-1 border-t border-kumo-line/70" />
          </>
        )}
        {showModels
          ? (
            <>
              {botRows && <p className={menuEyebrowClass}>Models</p>}
              {models.map((model) => {
                const active = selectedBot == null && selectedModel?.id === model.id;
                return (
                  <DropdownMenu.Item
                    key={model.id}
                    onClick={() => onModelChange(model.id)}
                    className={`${menuItemClass} cursor-pointer`}
                  >
                    <span className="min-w-0 flex-1 truncate">{model.name}</span>
                    {active && (
                      <Check
                        size={12}
                        weight="bold"
                        className="ml-3 flex-shrink-0 text-kumo-inactive"
                      />
                    )}
                  </DropdownMenu.Item>
                );
              })}
            </>
          )
          : defaultModelId !== null && (
            <DropdownMenu.Item
              onClick={() => onModelChange(defaultModelId)}
              className={`${menuItemClass} cursor-pointer`}
            >
              <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                <span className="w-full min-w-0 truncate text-kumo-default">Default agent</span>
                <span className="w-full min-w-0 truncate text-[11px] leading-[14px] text-kumo-inactive">
                  {defaultModelName}
                </span>
              </span>
              {selectedBot == null && selectedModel != null && (
                <Check
                  size={12}
                  weight="bold"
                  className="ml-3 flex-shrink-0 text-kumo-inactive"
                />
              )}
            </DropdownMenu.Item>
          )}
        <div className="my-1 border-t border-kumo-line/70" />
        <DropdownMenu.Item
          onClick={() => onModelChange(null)}
          className={`${menuItemClass} cursor-pointer`}
        >
          <span className="min-w-0 flex-1 truncate">No agent</span>
          {selectedBot == null && selectedModel == null && (
            <Check
              size={12}
              weight="bold"
              className="ml-3 flex-shrink-0 text-kumo-inactive"
            />
          )}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
};
