// The AI-model half of the user Durable Object (user.ts): the user's hand-added models, the
// quick/preferred selections, the free-tier daily LLM counter, and the chat-context resolution
// (gateway models vs stored ones, with the plan's model-tier gate) that chats and bots run on.
// The DO keeps its RPC surface as thin delegators (the user-bots.ts pattern); this store owns
// the storage keys it touches and nothing else spans them.

import {AiChatAuthorInfo, AiModelConfig, RedactedAiModelConfig, ModelKind, modelKind, createPlanRefusalError, type BotSelection} from '@gadgets/workshop-shared/api';
import { type UserAiModelRecord, type UserStorage} from "./storage-schema/user-storage.js";
import { type ResolvedUserBot } from "./user-bots.js";
import { allowedModelTiers } from "./user-plan.js";
import { getGatewayModels, type GatewayModels } from "./ai-gateway.js";
import { utcDayKey, nextUtcMidnightIso, DailyQuotaResult } from "./ai-gateway-billing/limits/config.js";


const withholdSecret = (secret: string) => secret === "" ? "" : null;

/** Withholds the non-empty secrets of `config`, for returning it to a client. */
function redactModelConfig(config: AiModelConfig): RedactedAiModelConfig {
  let {apiToken, extraHeaders, ...rest} = config;
  return {
    ...rest,
    apiToken: withholdSecret(apiToken),
    ...(extraHeaders && {extraHeaders: Object.fromEntries(
        Object.entries(extraHeaders).map(([name, value]) => [name, withholdSecret(value)]))}),
  };
}

/**
 * Fills in the `null` secrets of `config` from `source`, throwing if `source` is absent or doesn't
 * hold them. Secrets only carry over to the endpoint they were configured for: otherwise a client
 * could point the model at its own server and receive them.
 */
function resolveWithheldSecrets(
    config: RedactedAiModelConfig, source?: AiModelConfig): AiModelConfig {
  let resolve = (secret: string | null, stored: string | undefined, what: string) => {
    if (secret !== null) return secret;
    if (!source) {
      throw new Error(`A value for ${what} is required.`);
    }
    if (source.provider !== config.provider || (source.apiUrl ?? "") !== (config.apiUrl ?? "")) {
      throw new Error(`Please re-enter ${what}, since the provider or API URL changed.`);
    }
    if (stored === undefined) {
      throw new Error(`There is no stored ${what} to keep.`);
    }
    return stored;
  };

  let storedHeader = (name: string) => source?.extraHeaders && Object.hasOwn(source.extraHeaders, name)
      ? source.extraHeaders[name] : undefined;

  let {apiToken, extraHeaders, ...rest} = config;
  return {
    ...rest,
    apiToken: resolve(apiToken, source?.apiToken, "the API token"),
    ...(extraHeaders && {extraHeaders: Object.fromEntries(
        Object.entries(extraHeaders).map(([name, value]) =>
            [name, resolve(value, storedHeader(name), `the value of header "${name}"`)]))}),
  };
}

export type UserChatContext = {
  profile: AiChatAuthorInfo;
  aiModel?: UserAiModelRecord;
  quickModel?: AiModelConfig;
  /** The bot the chat runs as, when one was selected at intake; `aiModel` is then its model. */
  bot?: ResolvedUserBot;
}

/** The AI-model storage keys this store owns (a slice of the user DO's UserStorage). */
export type UserModelStorage = Pick<UserStorage,
    "aiModels" | "quickModel" | "preferredModel" | "onboardingCompleted" | "dailyLlmCount"
    | "profile">;

/**
 * The user's AI-model state: hand-added models, the quick/preferred model selections, the
 * onboarding flag, and the daily LLM-call counter. Also resolves chat contexts (the model a chat
 * runs on, including a declared bot's), applying the plan's model-tier gate in the one place so
 * listing, refusing, and availability cannot drift.
 *
 * Bot resolution stays with the DO (its bot store spans concerns this store doesn't own), passed
 * in as `resolveBot`.
 */
export class UserModelStore {
  constructor(
      private env: Cloudflare.Env,
      private userId: string,
      private storage: UserModelStorage,
      private resolveBot: (bot: BotSelection) => Promise<ResolvedUserBot>,
  ) {}

  async listModels(kind: ModelKind = "language"): Promise<AiChatAuthorInfo[]> {
    return this.#listModels(await getGatewayModels(this.env), kind,
        await allowedModelTiers(this.env, this.userId));
  }

  #listModels(models: GatewayModels | null, kind: ModelKind,
              tiers: ReadonlySet<string> | null): AiChatAuthorInfo[] {
    let result: AiChatAuthorInfo[] = [];

    // When AI Gateway mode is active, include the gateway models the deployment offers, less
    // any the user's plan may not run.
    if (models) {
      for (let model of models.list(kind)) {
        let tier = models.get(model.id)?.tier;
        if (this.tierAllowed(tier, tiers)) {
          result.push(model);
        }
      }
    }

    // Also include user-configured models, where users may add their own, skipping any that a
    // gateway model shadows, whatever its mode (see resolveModel()).
    if (models && !models.userModels) return result;
    for (let model of this.storage.aiModels.list()) {
      if (!models?.get(model.profile.id) &&
          modelKind(model.config.provider, model.config.model) === kind) {
        result.push(model.profile);
      }
    }
    return result;
  }

  /**
   * Whether the user's plan may run a model of `tier`: a model that states no catalog tier, and
   * every model while no entitlements service is bound (see `allowedModelTiers` in user-plan.ts), is never
   * tier-gated. The one home of the plan's model gate — listing (#listModels), refusing
   * (requireModel) and availability (the DO's bot listing) all ask it, so the three cannot drift.
   */
  tierAllowed(tier: string | undefined, tiers: ReadonlySet<string> | null): boolean {
    return tier === undefined || tiers === null || tiers.has(tier);
  }

  async addModel(profile: AiChatAuthorInfo, config: RedactedAiModelConfig,
                 copySecretsFrom?: string): Promise<void> {
    let models = await getGatewayModels(this.env);
    models?.refuseUserModel();
    let source: AiModelConfig | undefined;
    if (copySecretsFrom !== undefined) {
      source = this.#getHandAddedModel(copySecretsFrom, models).config;
    }
    // A gateway model, whatever its mode, would shadow the new model and leave it unreachable.
    if (this.storage.aiModels.get(profile.id) || models?.get(profile.id)) {
      throw new Error(`A model with ID "${profile.id}" already exists.`);
    }
    this.#putModel(profile, resolveWithheldSecrets(config, source), models);
  }

  async getModelConfig(id: string): Promise<{profile: AiChatAuthorInfo, config: RedactedAiModelConfig}> {
    let {profile, config} = this.#getHandAddedModel(id, await getGatewayModels(this.env));
    return {profile, config: redactModelConfig(config)};
  }

  async updateModel(profile: AiChatAuthorInfo, config: RedactedAiModelConfig): Promise<void> {
    let models = await getGatewayModels(this.env);
    models?.refuseUserModel();
    let stored = this.#getHandAddedModel(profile.id, models).config;
    if (config.provider !== stored.provider || config.model !== stored.model) {
      throw new Error("A model's provider and model ID can't be changed.");
    }
    this.#putModel(profile, resolveWithheldSecrets(config, stored), models);
  }

  /** The stored record of a model the user added, throwing for AI Gateway models. */
  #getHandAddedModel(id: string, models: GatewayModels | null): UserAiModelRecord {
    let record = this.storage.aiModels.get(id);
    // A stored model sharing a gateway model's ID is shadowed by it (see listModels()).
    if (!record || models?.get(id)) {
      throw new Error(`No such hand-added model: ${id}`);
    }
    return record;
  }

  #putModel(profile: AiChatAuthorInfo, config: AiModelConfig, models: GatewayModels | null) {
    if (models && !models.providers.has(config.provider)) {
      throw new Error(`Provider "${config.provider}" is not available in AI Gateway mode.`);
    }
    for (let limit of [config.contextWindow, config.outputLimit]) {
      if (limit !== undefined && !(Number.isSafeInteger(limit) && limit > 0)) {
        throw new Error("Token limits must be positive integers.");
      }
    }

    // capnweb-validate lets through properties that RedactedAiModelConfig omits, and these are a
    // deployment's to set on its own models.
    let {reasoning, compactionInputBudget, behavesLike, capabilities, ...own} = config;

    profile.type = "agent";
    this.storage.aiModels.put({profile, config: own});
  }

  async deleteModel(id: string): Promise<void> {
    // In AI Gateway mode, don't allow deleting the gateway's own models, whatever their mode.
    let model = (await getGatewayModels(this.env))?.get(id);
    if (model) throw new Error(`Cannot delete built-in model "${model.name}".`);

    this.storage.aiModels.delete(id);
  }

  async setQuickModel(id: string | null): Promise<void> {
    this.storage.quickModel.put(id);
  }

  async getQuickModel(): Promise<null | string> {
    let result = this.storage.quickModel.get();
    if (result && this.storage.aiModels.get(result)) {
      return result;
    } else {
      return null;
    }
  }

  async getPreferredModel(): Promise<string | null> {
    return this.storage.preferredModel.get();
  }

  async setPreferredModel(id: string | null): Promise<void> {
    if (id !== null) {
      // Any model that resolves is accepted, hidden ones included (see getExternalMessageChatContext()).
      if (!this.resolveModel(id, await getGatewayModels(this.env))) {
        throw new Error(`No such model: ${id}`);
      }
    }
    this.storage.preferredModel.put(id);
  }

  async isOnboardingCompleted(): Promise<boolean> {
    return this.storage.onboardingCompleted.get();
  }

  async completeOnboarding(): Promise<void> {
    this.storage.onboardingCompleted.put(true);
  }


  // ---------------------------------------------------------------------------------------------
  // Free-tier daily LLM-call counter (folded in from the former standalone RateLimitDO). Only used
  // when ENABLE_CLOUDFLARE_LIMITS is on. Single-threaded DO execution makes the read-modify-write
  // race-free; the window resets at UTC midnight when the stored day no longer matches.
  // ---------------------------------------------------------------------------------------------

  #dailyUsed(day: string): number {
    let record = this.storage.dailyLlmCount.get();
    return record && record.day === day ? record.count : 0;
  }

  /** Read the current daily quota state without counting a call. */
  async checkDailyLlmCount(limit: number): Promise<DailyQuotaResult> {
    let day = utcDayKey();
    let used = this.#dailyUsed(day);
    return { withinLimits: used < limit, remaining: Math.max(0, limit - used), limit, used,
             resetAt: nextUtcMidnightIso() };
  }

  /**
   * Atomically check the daily limit and, if within it, count one call. `withinLimits` is the
   * pre-count decision; `used`/`remaining` reflect the state AFTER counting. No-ops once exhausted,
   * so a blocked request never counts.
   */
  async consumeDailyLlmCall(limit: number): Promise<DailyQuotaResult> {
    let day = utcDayKey();
    let used = this.#dailyUsed(day);
    if (used >= limit) {
      return { withinLimits: false, remaining: 0, limit, used, resetAt: nextUtcMidnightIso() };
    }
    let newUsed = used + 1;
    this.storage.dailyLlmCount.put({ day, count: newUsed });
    return { withinLimits: true, remaining: Math.max(0, limit - newUsed), limit, used: newUsed,
             resetAt: nextUtcMidnightIso() };
  }

  /** DO NOT MAKE PUBLIC -- returns API keys. Pure read: call sites replay it across DO resets
   * via retryOnDoReset, so it must stay free of writes and side effects.
   *
   * `bot` names a declared bot to run the chat as (see the DO's listBots) and wins over
   * `modelId`: the chat runs on the bot's declared model. A bot or model that no longer resolves
   * throws visibly here, never a silent fallback to another model. */
  async getChatContext(modelId: string | null, bot?: BotSelection): Promise<UserChatContext> {
    let [models, tiers] = await Promise.all(
        [getGatewayModels(this.env), allowedModelTiers(this.env, this.userId)]);
    let result = this.#getChatContext(bot === undefined ? modelId : null, models, tiers);
    if (bot !== undefined) {
      result.bot = await this.resolveBot(bot);
      result.aiModel = this.requireModel(result.bot.modelId, models, tiers);
    }
    return result;
  }

  #getChatContext(modelId: string | null, models: GatewayModels | null,
                 tiers: ReadonlySet<string> | null): UserChatContext {
    let result: UserChatContext = {
      profile: this.storage.profile.get()
    };
    if (modelId) {
      result.aiModel = this.requireModel(modelId, models, tiers);
    }

    // Resolve the quick model (used for lightweight tasks like title generation).
    if (models) {
      // In AI Gateway mode, always use the hardcoded quick model.
      result.quickModel = models.gateway.getQuickModelConfig();
    } else {
      let quickModelId = this.storage.quickModel.get();
      if (quickModelId) {
        let quickModel = this.storage.aiModels.get(quickModelId);
        if (quickModel) {
          result.quickModel = quickModel.config;
        }
      }
    }
    return result;
  }

  /**
   * Resolve a model ID the way chats do (see resolveModel), refusing visibly -- with the most
   * specific reason the ID doesn't resolve -- when it doesn't. Shared by the plain-model and bot
   * paths of getChatContext, so a bot's model refuses exactly like a hand-picked one. A gateway
   * model whose catalog tier the user's plan doesn't include refuses here too (see
   * `allowedModelTiers`), so a chat naming one — an existing chat after a downgrade, say — fails
   * visibly rather than silently running a different model.
   */
  requireModel(id: string, models: GatewayModels | null,
               tiers: ReadonlySet<string> | null): UserAiModelRecord {
    let record = this.resolveModel(id, models);
    if (record) {
      let tier = models?.get(id)?.tier;
      if (!this.tierAllowed(tier, tiers)) {
        throw createPlanRefusalError("MODEL_NOT_ON_PLAN",
            `The "${record.profile.name}" model isn't available on your plan.`);
      }
      return record;
    }
    models?.refuseDisabled(id);
    // No gateway model has the ID, so a stored model with it is one the deployment keeps
    // users from running.
    let stored = this.storage.aiModels.get(id);
    if (stored) models?.refuseUserModel(stored.profile.name);
    throw new Error(`No such model: ${id}`);
  }


  async getExternalMessageChatContext(existingChatModelId: string | null): Promise<UserChatContext> {
    // An existing chat keeps its model while it still resolves, even once no longer offered. A new
    // conversation takes the user's preferred model only while it is still offered, as the web
    // composer does with its stored choice, and otherwise the first available model.
    let [models, tiers] = await Promise.all(
        [getGatewayModels(this.env), allowedModelTiers(this.env, this.userId)]);
    let selectedModelId = existingChatModelId;
    if (selectedModelId === null || !this.resolveModel(selectedModelId, models)) {
      let offered = this.#listModels(models, "language", tiers);
      let preferredModel = this.storage.preferredModel.get();
      selectedModelId = (offered.find(model => model.id === preferredModel) ?? offered[0])?.id ?? null;
    }

    return this.#getChatContext(selectedModelId, models, tiers);
  }

  /**
   * Resolve a model ID the way chats do: a gateway model shadows a stored model with the same ID
   * whatever its mode, so a disabled one resolves to nothing rather than to the stored model. No
   * stored model resolves on a gateway deployment whose users may not add their own. Shared with
   * the DO's bot listing (its availability check) so a bot and its chat resolve identically.
   */
  resolveModel(id: string, models: GatewayModels | null): UserAiModelRecord | undefined {
    if (models?.get(id)) return models.resolve(id);
    return models && !models.userModels ? undefined : this.storage.aiModels.get(id);
  }
}
