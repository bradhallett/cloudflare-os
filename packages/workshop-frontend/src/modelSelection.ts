import type { AiChatAuthorInfo, BotInfo, BotSelection } from "@gadgets/workshop-shared/api";

const LAST_SELECTED_MODEL_KEY = "lastSelectedModel";
/** The localStorage key under which the intake picker's default bot is stored. */
export const LAST_SELECTED_BOT_KEY = "lastSelectedBot";

/** Sentinel used for UI values and localStorage so an explicit null choice can persist. */
export const NO_AGENT_OPTION_VALUE = "__gadgets_no_agent__";

export function getStoredSelectedModel(
  models: AiChatAuthorInfo[],
): string | null {
  const storedModel = localStorage.getItem(LAST_SELECTED_MODEL_KEY);

  if (storedModel === NO_AGENT_OPTION_VALUE) {
    return null;
  }

  if (storedModel && models.some((model) => model.id === storedModel)) {
    return storedModel;
  }

  // Default: Return the first configured model, or null if none are configured.
  return models[0]?.id ?? null;
}

export function persistSelectedModel(modelId: string | null): void {
  localStorage.setItem(
    LAST_SELECTED_MODEL_KEY,
    modelId ?? NO_AGENT_OPTION_VALUE,
  );
}

export function toModelSelectValue(modelId: string | null): string {
  return modelId ?? NO_AGENT_OPTION_VALUE;
}

export function fromModelSelectValue(value: string): string | null {
  return value === NO_AGENT_OPTION_VALUE ? null : value;
}

/** The localStorage key format for a bot selection: `${scope}:${id}`. */
export function botSelectionKey(selection: BotSelection): string {
  return `${selection.scope}:${selection.id}`;
}

/** Whether two bot selections name the same bot (same scope and id). */
export function sameBotSelection(
  a: BotSelection,
  b: BotSelection | undefined,
): boolean {
  return b !== undefined && a.scope === b.scope && a.id === b.id;
}

/**
 * The bot persisted as the intake picker's default, when it names one of `bots`. Unlike models,
 * there is no fallback: a bot is chosen deliberately, so a stored choice that no longer resolves
 * starts intake on the default model rather than guessing another bot.
 */
export function getStoredSelectedBot(bots: BotInfo[]): BotSelection | null {
  const storedKey = localStorage.getItem(LAST_SELECTED_BOT_KEY);
  if (!storedKey) return null;
  return bots.find((bot) => botSelectionKey(bot.selection) === storedKey)
    ?.selection ?? null;
}

/** Persists the intake default bot; `null` (no bot chosen) clears the stored choice. */
export function persistSelectedBot(selection: BotSelection | null): void {
  if (selection === null) {
    localStorage.removeItem(LAST_SELECTED_BOT_KEY);
  } else {
    localStorage.setItem(LAST_SELECTED_BOT_KEY, botSelectionKey(selection));
  }
}
