// A declared bot: a named agent with pre-set instructions, a model, and skills, picked instead
// of a model when starting or steering a chat. Bots exist in two scopes, merged everywhere they
// are listed: each user's own (`BotApiMethods` on `AuthenticatedApi`) and the deployment's
// (`DeploymentBotAdminMethods` on `AdminApi`). A chat running as a bot can delegate to other
// bots as subagents and exchange direct messages with them. `api.ts` re-exports every name
// here, so importers of `@gadgets/workshop-shared/api` are unaffected by this module's
// existence.

/**
 * A skill a bot declares, identified like a slash command (`vendorId` + `commandId`), which is
 * stable across workspaces. `name` is display-only, captured at declaration time; the reference
 * is resolved against a workspace's gatekeepers when a bot chat starts.
 */
export type BotSkillRef = {
  /** Vendor whose gatekeeper offers the skill. */
  vendorId: string;
  /** The command to activate, as that vendor names it. */
  commandId: string;
  /** Display name captured when the skill was declared; never used for resolution. */
  name: string;
};

/** Maximum length (characters) of a bot's name. */
export const MAX_BOT_NAME_LENGTH = 64;

/** Maximum length (characters) of a bot's description. */
export const MAX_BOT_DESCRIPTION_LENGTH = 200;

/** Maximum length (characters) of a bot's instructions. */
export const MAX_BOT_INSTRUCTIONS_LENGTH = 8000;

/** Maximum number of skills a bot may declare. */
export const MAX_BOT_SKILLS = 50;

/**
 * A bot's declaration. `modelId` names a model as it resolved for the declaring user; a chat
 * started as the bot refuses visibly if that model no longer resolves for the user starting it.
 */
export type BotDefinition = {
  /** Unique within the bot's scope. */
  name: string;
  /** One-line summary shown in pickers and bot lists. */
  description?: string;
  /** Standing instructions added to the bot's system prompt. */
  instructions: string;
  /** The model the bot runs on. */
  modelId: string;
  /** Skills the bot may activate on demand (see the activateSkill tool). */
  skills: BotSkillRef[];
};

/** Identifies a bot by scope, for passing into chat APIs. */
export type BotSelection = {
  scope: "user" | "deployment";
  id: string;
};

/** One bot as listed for pickers: its identity plus whether it can start a chat right now. */
export type BotInfo = {
  selection: BotSelection;
  name: string;
  description?: string;
  modelId: string;
  /** Display name of the bot's model, when it resolves. */
  modelName?: string;
  /**
   * Whether a chat can start with this bot now. False means the bot's model no longer resolves
   * for this user; such a bot stays listed (disabled, with `unavailableReason`) rather than
   * disappearing from underneath chats that picked it.
   */
  available: boolean;
  unavailableReason?: string;
};

/** One skill a bot can declare, as offered by the user's connected accounts. */
export type BotSkillChoice = {
  /** With `commandId`, the stable reference to store in a BotSkillRef. */
  vendorId: string;
  /** With `vendorId`, the stable reference to store in a BotSkillRef. */
  commandId: string;
  /** Display name captured into the declaration. */
  name: string;
  /** What the skill does, shown in the picker. */
  description: string;
  /** Name of the account or gatekeeper offering the skill. */
  providerLabel: string;
};

/**
 * The bot methods of `AuthenticatedApi`: the user's own bots, plus the skills their connected
 * accounts offer for declaring on one.
 */
export interface BotApiMethods {
  /**
   * List the bots offered to this user: their own plus the deployment's (see AdminApi), merged.
   * A bot whose model no longer resolves for this user is listed with `available: false` rather
   * than dropped, so it stays visible wherever it was picked.
   */
  listBots(): Promise<BotInfo[]>;

  /**
   * Get one of this user's own bots' definitions. Deployment bots are public metadata already
   * covered by `listBots()` and are never read through this method, so a deployment slug
   * colliding with a user bot id is impossible.
   */
  getBot(id: string): Promise<BotDefinition>;

  /**
   * Create a bot owned by this user and return its id. `name` must be unique among the user's
   * own bots; lengths and skill counts are capped as the MAX_BOT_* constants declare.
   */
  createBot(def: BotDefinition): Promise<string>;

  /** Replace one of this user's own bots' definitions. */
  updateBot(id: string, def: BotDefinition): Promise<void>;

  /** Delete one of this user's own bots. Chats that used it keep their frozen snapshot. */
  deleteBot(id: string): Promise<void>;

  /**
   * List the skills this user can declare on a bot: the slash commands offered by their
   * connected accounts' agent singletons (e.g. the Context Library). Vendors whose singleton
   * cannot be reached are skipped, not fatal.
   */
  listBotSkills(): Promise<BotSkillChoice[]>;
}

/**
 * The deployment-bot methods of `AdminApi`: deployment-wide bots offered to every user
 * alongside their own (see `BotApiMethods.listBots`).
 */
export interface DeploymentBotAdminMethods {
  /**
   * List the deployment's bots, offered to every user alongside their own (see
   * AuthenticatedApi.listBots).
   */
  listDeploymentBots(): Promise<(BotDefinition & {id: string})[]>;

  /**
   * Add a deployment-wide bot. `id` is a lowercase slug naming it in BotSelections; it must be a
   * valid unique identifier. The definition is validated like a user bot's.
   */
  addDeploymentBot(id: string, def: BotDefinition): Promise<void>;

  /** Replace a deployment-wide bot's definition. The `id` names it; the definition has no id. */
  updateDeploymentBot(id: string, def: BotDefinition): Promise<void>;

  /** Remove a deployment-wide bot. Chats that used it keep their frozen snapshot. */
  removeDeploymentBot(id: string): Promise<void>;
}
