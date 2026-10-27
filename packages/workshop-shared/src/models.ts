// The AI model vocabulary: providers, gateways, model settings and capabilities, the admin
// and user-facing projections, and the built-in suggested-model tables. Also home of
// ModelApiMethods, the model-management methods of AuthenticatedApi. Re-exported from
// api.ts, the single import surface of the API.


import type { AiChatAuthorInfo } from "./chat.js";
import type { ModelTier } from "./entitlements.js";
/** Supported AI providers. */
export type AiModelProvider = "openai" | "anthropic" | "google" | "cloudflare" | "ollama";

/** Information about the AI gateway configuration. Returned by `AuthenticatedApi.getAiConfig()`. */
export type AiGatewayInfo = {
  enabled: true;
  /**
   * The providers the deployment enables: the ones CF_AI_GATEWAY_PROVIDERS lists and the ones its
   * admin turned on (see AdminApi.setGatewayProviderEnabled). A user can add a model of their own
   * under these only.
   */
  enabledProviders: AiModelProvider[];
  /**
   * The ID of every model the deployment provides through AI Gateway, in any mode (see
   * GatewayModelMode). A user can't edit or delete these, nor add a model under one of these IDs.
   */
  builtInModelIds: string[];
  /**
   * Whether users may add models of their own (see AdminApi.setUserModelsEnabled). When false,
   * addModel() and updateModel() refuse, and the models the user added are neither listed nor
   * resolved.
   */
  userModelsEnabled: boolean;
} | {
  enabled: false;
};

/**
 * How a deployment offers one of the models it provides through AI Gateway:
 *   - 'enabled':  offered in model pickers.
 *   - 'hidden':   left out of pickers but still resolves, so the chats, spawners, preferences and
 *                 gadget model bindings that already name it keep working.
 *   - 'disabled': left out of pickers and does not resolve: a chat or spawner that names it is
 *                 refused, and a gadget model binding minted for it fails at its next call. Its ID
 *                 stays reserved, so a user can't add a model of their own under it.
 */
export const GATEWAY_MODEL_MODES = ['enabled', 'hidden', 'disabled'] as const;

/** One of GATEWAY_MODEL_MODES. */
export type GatewayModelMode = typeof GATEWAY_MODEL_MODES[number];

/** Whether `value` is a GatewayModelMode. */
export function isGatewayModelMode(value: unknown): value is GatewayModelMode {
  return GATEWAY_MODEL_MODES.includes(value as GatewayModelMode);
}

/**
 * How much reasoning a model is asked for on an agent's turns, least to most. The values are the
 * model runtime's own (pi's ModelThinkingLevel). Each model takes some of them. One it lacks is
 * fitted to the next higher one it has, or else the next lower, so 'off' on a model that cannot
 * stop reasoning asks for its lowest level. A model that does no reasoning is sent none.
 */
export const REASONING_LEVELS =
    ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** One of REASONING_LEVELS. */
export type ReasoningLevel = typeof REASONING_LEVELS[number];

/** Whether `value` is a ReasoningLevel. */
export function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return REASONING_LEVELS.includes(value as ReasoningLevel);
}

/**
 * What a model is asked for while no reasoning level is set for it: 'adaptive' when the model
 * itself decides whether and how much to reason, a level when the Workshop asks for that effort,
 * and null when no level is sent.
 */
export type BuiltInReasoning = ReasoningLevel | 'adaptive' | null;

/**
 * The share of its compaction budget a chat's prompt may reach before the chat compacts, leaving
 * room for the response.
 */
export const COMPACTION_TRIGGER_RATIO = 0.85;

/**
 * What a deployment's admin sets for one of its AI Gateway models. A field left out is unset: the
 * model then has its built-in behaviour, or for `reasoning` the deployment's default level where
 * one is set.
 */
export type GatewayModelSettings = {
  /**
   * The reasoning level of the agent's turns on the model, ahead of the deployment's default
   * (see AdminApi.setDefaultReasoning). One-shot calls, such as titles, compaction summaries
   * and gadget model bindings, ask for none either way.
   */
  reasoning?: ReasoningLevel;

  /**
   * The prompt budget, in tokens, that a chat on the model compacts against (see
   * COMPACTION_TRIGGER_RATIO), in place of the model's built-in one. A positive whole number, at
   * most the model's AdminModelView.maxCompactionInputBudget.
   */
  compactionInputBudget?: number;
};

/**
 * What a deployment's admin states that a model it adds can do. Nothing checks a stated fact
 * against the provider: requests are built from it as it stands.
 */
export type GatewayModelCapabilities = {
  /** Whether the model takes images as input, beside text. Absent while not stated. */
  imageInput?: boolean;

  /**
   * The reasoning levels the model can be sent. A list with no level above 'off' states a model
   * that does no reasoning. Absent while not stated.
   */
  reasoningLevels?: ReasoningLevel[];
};

/**
 * The description of a model a deployment provides through AI Gateway. Its admin supplies one to
 * add a model beside the SUGGESTED_MODELS of the providers the gateway enables.
 */
export type GatewayModel = {
  /** Which AI provider hosts the model. */
  provider: AiModelProvider;

  /**
   * Name of the model as specified to the provider's API, which is also the ID chats and
   * preferences refer to it by.
   */
  id: string;

  /** Display name. */
  name: string;

  /** The maximum tokens one request may total. */
  contextWindow: number;

  /** When present, both the requested response cap and the space reserved for it. */
  outputLimit?: number;

  /**
   * The ID of a model of the same provider that the model runtime knows. While the runtime has
   * no entry for this model's own ID, the model borrows that one's runtime flags: its request
   * formats and, for what `capabilities` leaves unstated, its reasoning levels and the kinds of
   * input it takes. Its name, limits and cost stay its own.
   */
  behavesLike?: string;

  /**
   * What the model is stated to do. Used only while the runtime has no entry for this model's
   * own ID, where each stated fact comes ahead of what `behavesLike` lends.
   */
  capabilities?: GatewayModelCapabilities;

  /** The model's coarse plan tier, as SUGGESTED_MODELS states one (see SuggestedModel.tier). */
  tier?: ModelTier;
};

/** A model a deployment provides through AI Gateway, as its admin sees it. */
export type AdminModel = GatewayModel & {
  /** How the deployment offers the model. */
  mode: GatewayModelMode;

  /**
   * The mode the model has while the admin leaves it alone: SUGGESTED_MODELS decides it for a
   * suggested model, and an added model's is 'enabled'.
   */
  defaultMode: GatewayModelMode;

  /** Whether the admin added the model, rather than SUGGESTED_MODELS listing it. */
  added: boolean;

  /** What the admin set for the model. Absent while nothing is set. */
  settings?: GatewayModelSettings;
};

/** An AdminModel with what the admin UI needs in order to offer its settings. */
export type AdminModelView = AdminModel & {
  /** The reasoning levels the model can be sent, least to most. Empty when it takes none. */
  reasoningLevels: ReasoningLevel[];

  /**
   * What the model is asked for while neither its settings nor the deployment's default give it
   * a reasoning level.
   */
  builtInReasoning: BuiltInReasoning;

  /** The compaction budget the model has while GatewayModelSettings sets none. */
  builtInCompactionInputBudget: number;

  /**
   * The largest compaction budget the model may be given: the room its context window leaves for
   * a prompt.
   */
  maxCompactionInputBudget: number;

  /**
   * Whether the model runtime has an entry for the model's own ID. When it has, the runtime's
   * entry is used, and neither `behavesLike` nor `capabilities` is.
   */
  runtimeKnown: boolean;

  /**
   * For a model with a `behavesLike`, whether the model runtime knows the model it names. When
   * it does not, there is nothing to borrow, and the model runs as one the runtime does not know
   * for as long as it has no entry for the model's own ID either.
   */
  behavesLikeKnown?: boolean;
};

/** One of the providers AI Gateway serves, as a deployment's admin sees it. */
export type AdminGatewayProvider = {
  /** The provider. */
  provider: AiModelProvider;

  /**
   * Who enabled the provider: the CF_AI_GATEWAY_PROVIDERS environment variable, or an admin (see
   * AdminApi.setGatewayProviderEnabled). Absent while the provider is off.
   */
  enabledBy?: 'environment' | 'admin';

  /**
   * Whether the provider's requests need CF_AI_GATEWAY_API_TOKEN on a deployment that has none,
   * so that they fail until it is set. It says nothing of the provider keys the gateway holds,
   * which the Workshop can't see (see AdminApi.testGatewayProvider).
   */
  needsApiToken: boolean;
};

/**
 * What one request of AdminApi.testGatewayProvider(), AdminApi.testGatewayModel() or
 * AdminApi.testNewGatewayModel() found: the model asked, and whether it answered. A failure
 * carries a message on one line, cut short: what the provider or the gateway answered, or why no
 * answer came. It carries the HTTP status of the response only when the model runtime reports
 * one, which it does not for every provider (a failed Google request has none): the message then
 * says what there is.
 */
export type GatewayModelTest = { model: string } &
    ({ ok: true } | { ok: false; status?: number; message: string });

/**
 * One request of AdminApi.testNewGatewayModel(): its result, and the reasoning level it asked
 * for. Null is the request sent with no level set.
 */
export type GatewayModelLevelTest = GatewayModelTest & { reasoning: ReasoningLevel | null };

/** Configuration specifying how to connect to an AI model provider. */
export type AiModelConfig = {
  /** Which AI provider hosts the model? */
  provider: AiModelProvider;

  /** Name of the specific model, as specified to the provider's API. */
  model: string;

  /**
   * Secret API token for the respective provider, for billing purposes. For providers "anthropic",
   * "openai", and "ollama", an empty token means no key is sent at all, e.g. because a proxy
   * authenticated through `extraHeaders` supplies its own.
   */
  apiToken: string;

  /**
   * Cloudflare account ID owning the Workers AI deployment the token authorizes. Required for
   * provider "cloudflare" (whose REST endpoint is account-scoped); unused for other providers.
   */
  accountId?: string;

  /**
   * URL of the API. If not specified, use the default for the provider. Overriding the URL is
   * useful in order to use AI proxy products like Cloudflare's AI gateway, or even to use an
   * alternative provider that provides a compatible API.
   */
  apiUrl?: string;

  /**
   * Additional HTTP headers to send with every request to the provider, keyed by header name.
   * These override the provider's default headers of the same name (including authentication
   * headers), which is useful for proxies that require their own credentials. Like `apiToken`
   * and `apiUrl`, these are ignored when the Workshop routes requests through its own AI
   * Gateway configuration rather than contacting the provider directly.
   */
  extraHeaders?: Record<string, string>;

  /**
   * The maximum tokens one request may total, overriding the Workshop's built-in value for this
   * model. Useful for a model the Workshop doesn't know, which is otherwise assumed to be small.
   */
  contextWindow?: number;

  /**
   * Overrides the built-in response cap for this model. Like `outputLimit` in the suggested-model
   * table, it is both the requested response cap and the space reserved for it in the window.
   */
  outputLimit?: number;

  /**
   * The reasoning level of an agent's turns on the model. Absent gives the model's built-in
   * behaviour. Set only on a deployment's AI Gateway models (see GatewayModelSettings).
   */
  reasoning?: ReasoningLevel;

  /**
   * Overrides the model's built-in compaction budget, up to the room its window leaves for a
   * prompt. Set only on a deployment's AI Gateway models (see GatewayModelSettings).
   */
  compactionInputBudget?: number;

  /**
   * The model whose runtime flags this one borrows (see GatewayModel.behavesLike). Set only on
   * the models a deployment's admin added to its AI Gateway.
   */
  behavesLike?: string;

  /**
   * What the model is stated to do (see GatewayModel.capabilities). Set only on the models a
   * deployment's admin added to its AI Gateway.
   */
  capabilities?: GatewayModelCapabilities;
};

/**
 * An `AiModelConfig` whose secrets may be withheld, so that a stored configuration can be shown
 * and edited without the client ever receiving its secrets. As returned by
 * `AuthenticatedApi.getModelConfig()`, a `null` secret is a non-empty value that was withheld. As
 * passed to `AuthenticatedApi.updateModel()` or `addModel()`, a `null` secret keeps (or copies)
 * the stored value. It has none of the fields that only a deployment sets on its own models.
 */
export type RedactedAiModelConfig = Omit<AiModelConfig,
    "apiToken" | "extraHeaders" | "reasoning" | "compactionInputBudget" | "behavesLike" |
    "capabilities"> & {
  /** `AiModelConfig.apiToken`, or null if withheld. */
  apiToken: string | null;

  /** `AiModelConfig.extraHeaders`, with each value null if withheld. */
  extraHeaders?: Record<string, string | null>;
};

/**
 * Workers AI adds the response cap to the prompt and rejects a request whose total exceeds the
 * model's window, so every Cloudflare model reserves this much of it for the response.
 */
export const WORKERS_AI_OUTPUT_LIMIT = 32768;

/**
 * What a model does, which decides where it can be used. A `"language"` model writes text: it can
 * chat and back a `LanguageModelBinding`. A `"decision"` model answers typed questions with
 * probabilities: gadgets can bind it as a `DecisionModelBinding`, but it can't chat.
 */
export type ModelKind = "language" | "decision";

/** One entry of SUGGESTED_MODELS. */
type SuggestedModel = {
  name: string;

  /** The maximum tokens one request may total. */
  contextWindow: number;

  /** When present, both the requested response cap and the space reserved for it. */
  outputLimit?: number;

  /**
   * When present, the preferred prompt budget used for compaction, below the model's hard context
   * window. Can avoid long-context pricing (GPT-5.6 doubles above 272K) while retaining the full
   * window as the hard limit.
   */
  compactionInputBudget?: number;

  /**
   * Makes the model's default mode 'hidden' rather than 'enabled' (see GatewayModelMode): still
   * resolvable for stored references, not offered in pickers. Set on models superseded by a newer
   * one, which chats, spawners, and preferences created earlier may still name. A deployment's
   * admin can override the default for its AI Gateway.
   */
  hidden?: true;

  /**
   * The model's coarse class (e.g. "standard", "premium"), compared against the model tiers a
   * bound SaaS entitlements service allows (see @gadgets/workshop-shared/entitlements). Opaque
   * descriptive data: inert on a deployment with no such service bound, and a model that states
   * no tier is never tier-gated.
   */
  tier?: ModelTier;

  /** The model's kind; absent means `"language"`. */
  kind?: ModelKind;
};

// The literal is kept apart from the export so SuggestedModelId can derive the model ids from it.
const SUGGESTED_MODEL_CATALOG = {
  "cloudflare": {
    "@cf/moonshotai/kimi-k2.7-code": {
      name: "Kimi K2.7 Code (Workers AI)", contextWindow: 262144,
      outputLimit: WORKERS_AI_OUTPUT_LIMIT, tier: "standard",
    },
    "@cf/zai-org/glm-5.2": {
      name: "GLM 5.2 (Workers AI)", contextWindow: 262144, outputLimit: WORKERS_AI_OUTPUT_LIMIT,
      tier: "standard",
    },
    "@cf/zai-org/glm-5.3-flash": {
      name: "GLM 5.3 Flash (Workers AI)", contextWindow: 1048576,
      outputLimit: WORKERS_AI_OUTPUT_LIMIT, tier: "standard",
    },
    "@cf/deepseek-ai/deepseek-v4-pro-0813": {
      name: "DeepSeek V4 Pro 0813 (Workers AI)", contextWindow: 1048576,
      outputLimit: WORKERS_AI_OUTPUT_LIMIT, tier: "standard",
    },
    "@cf/cloudflare/clef": {
      name: "Clef (Workers AI)", contextWindow: 65536, kind: "decision", tier: "standard",
    },
    "@cf/cloudflare/clef-flash": {
      name: "Clef Flash (Workers AI)", contextWindow: 65536, kind: "decision", tier: "standard",
    },
  },
  "anthropic": {
    "claude-opus-5-5": {name: "Claude Opus 5.5", contextWindow: 1000000, tier: "premium"},
    "claude-sonnet-5-5": {name: "Claude Sonnet 5.5", contextWindow: 1000000, tier: "premium"},
    "claude-fable-5-1": {name: "Claude Fable 5.1", contextWindow: 1000000, tier: "premium"},
    "claude-opus-5": {name: "Claude Opus 5", contextWindow: 1000000, hidden: true, tier: "premium"},
    "claude-sonnet-5": {name: "Claude Sonnet 5", contextWindow: 1000000, hidden: true, tier: "premium"},
    "claude-haiku-4-5": {name: "Claude Haiku 4.5", contextWindow: 200000, tier: "standard"},
  },
  "openai": {
    // pi's GPT-6 catalog reports a 272K window, but these models support 1.05M. Use 272K as the
    // preferred compaction budget, not as the hard context limit.
    "gpt-6.1-sol": {
      name: "GPT-6.1 Sol", contextWindow: 1050000, outputLimit: 128000,
      compactionInputBudget: 272000, tier: "premium",
    },
    "gpt-6-sol": {
      name: "GPT-6 Sol", contextWindow: 1050000, outputLimit: 128000,
      compactionInputBudget: 272000, hidden: true, tier: "premium",
    },
    "gpt-6-luna": {
      name: "GPT-6 Luna", contextWindow: 1050000, outputLimit: 128000,
      compactionInputBudget: 272000, tier: "premium",
    },
    "gpt-6-astra": {
      name: "GPT-6 Astra", contextWindow: 1050000, outputLimit: 128000,
      compactionInputBudget: 272000, tier: "premium",
    },
    "gpt-5.6-sol": {
      name: "GPT 5.6 Sol", contextWindow: 1050000, outputLimit: 128000,
      compactionInputBudget: 272000, hidden: true, tier: "standard",
    },
    "gpt-5.6-luna": {
      name: "GPT 5.6 Luna", contextWindow: 1050000, outputLimit: 128000,
      compactionInputBudget: 272000, hidden: true, tier: "standard",
    },
    "gpt-5.6-terra": {
      name: "GPT 5.6 Terra", contextWindow: 1050000, outputLimit: 128000,
      compactionInputBudget: 272000, hidden: true, tier: "standard",
    },
  },
  "google": {
    "gemini-3.6-flash": {name: "Gemini 3.6 Flash", contextWindow: 1048576, tier: "standard"},
  },
  "ollama": {
  },
} satisfies Record<AiModelProvider, Record<string, SuggestedModel>>;

/**
 * Models built into the Workshop, by provider and model id. Pickers skip the hidden ones, unless
 * the admin of an AI Gateway deployment enabled them there.
 */
export const SUGGESTED_MODELS: Record<AiModelProvider, Record<string, SuggestedModel>> =
    SUGGESTED_MODEL_CATALOG;

/** A model ID listed in SUGGESTED_MODELS, optionally narrowed to one provider's catalog. */
export type SuggestedModelId<P extends AiModelProvider = AiModelProvider> =
  { [K in P]: keyof (typeof SUGGESTED_MODEL_CATALOG)[K] & string }[P];

/** The kind of a model, named by its provider and its ID on the provider's API. */
export function modelKind(provider: string, model: string): ModelKind {
  return SUGGESTED_MODELS[provider as AiModelProvider]?.[model]?.kind ?? "language";
}

/**
 * Providers whose pi API adapter refuses a custom fetch, so their inference cannot ride the
 * Workers AI binding and needs CF_AI_GATEWAY_API_TOKEN over HTTPS. pi's Google adapter throws
 * "Custom fetch is not supported by the Google Generative AI adapter" whenever the fetch it is
 * given is not globalThis.fetch, and the client it builds on offers no hook to route around that:
 * @google/genai's `GoogleGenAI` takes only `httpOptions`, whose knobs are
 * baseUrl/apiVersion/headers/timeout/extraBody/retryOptions.
 * https://github.com/earendil-works/pi/blob/v0.84.2/packages/ai/src/api/google-generative-ai.ts#L80
 *
 * pi's Vertex adapter throws the same way, so a google-vertex provider would belong here too; it
 * is absent only because this deployment has no such provider.
 * https://github.com/earendil-works/pi/blob/v0.84.2/packages/ai/src/api/google-vertex.ts#L98
 */
export const HTTPS_ONLY_PROVIDERS: ReadonlySet<string> = new Set<AiModelProvider>(["google"]);

/**
 * The AI-model management methods of AuthenticatedApi: the signed-in user's model catalog
 * and their quick and preferred model choices. Split out of the session core so the model
 * vocabulary and its methods live in one module.
 */
export interface ModelApiMethods {
  /**
   * List the user's configured AI models of one kind, by default the language models, which can
   * chat.
   *
   * Note that the list returned here could be different from a particular gadget's Overseer,
   * especially if the gadget is owned by someone else.
   */
  listModels(kind?: ModelKind): Promise<AiChatAuthorInfo[]>;

  /**
   * Adds a new model to the user's configured set. The ID must not name a model the user already
   * added; use `updateModel()` to replace one.
   *
   * `copySecretsFrom` names a hand-added model (see `getModelConfig()`) whose stored secrets fill
   * in the `null` secrets of `config`, which is how a model is cloned without the client ever
   * holding the secrets. The rules of `updateModel()` for keeping a secret apply to copying one.
   * Without it, `config` must contain no `null` secrets. With it, `profile.id` must also not name
   * a model provided by the deployment's AI Gateway configuration.
   *
   * Throws on a deployment whose users may not add their own models (see
   * `AiGatewayInfo.userModelsEnabled`), as `updateModel()` does.
   */
  addModel(profile: AiChatAuthorInfo, config: RedactedAiModelConfig,
           copySecretsFrom?: string): Promise<void>;

  /**
   * Gets the profile and configuration of a model the user added by hand, i.e. not one provided
   * by the deployment's AI Gateway configuration, with its secrets withheld.
   */
  getModelConfig(id: string): Promise<{profile: AiChatAuthorInfo, config: RedactedAiModelConfig}>;

  /**
   * Replaces the configuration of a model the user added by hand. `profile.id` names the model,
   * and `config.provider` and `config.model` must match the stored values.
   *
   * A `null` secret keeps the stored value; for a header, that of the stored header with exactly
   * the same name. Secrets may be kept only while `config.provider` and `config.apiUrl` are
   * unchanged, since otherwise the client could direct the stored secrets to a server it controls.
   * Passing back what `getModelConfig()` returned therefore changes nothing.
   */
  updateModel(profile: AiChatAuthorInfo, config: RedactedAiModelConfig): Promise<void>;

  /** Deletes a configured model. */
  deleteModel(id: string): Promise<void>;

  /**
   * Set the model to use for simple quick tasks, like generating chat titles. Set null to
   * disable quick model use (e.g. chats will be titled "New Chat").
   */
  setQuickModel(id: string | null): Promise<void>;

  /** Get the quick model setting. */
  getQuickModel(): Promise<null | string>;

  /**
   * Get AI configuration info, including whether AI Gateway mode is active and which providers
   * are available. The frontend uses this to adjust the model management UI.
   */
  getAiConfig(): Promise<AiGatewayInfo>;

  /**
   * Get the user's preferred model, chosen during onboarding. Returns null if the user has not
   * set a preference (or explicitly chose "No agent"). The preference may name a model that is
   * no longer offered (see setPreferredModel).
   */
  getPreferredModel(): Promise<string | null>;

  /**
   * Set the user's preferred model. Pass null to indicate "No agent". Any model that resolves is
   * accepted, including one hidden from pickers, but a new external conversation uses the
   * preference only while it is offered, and otherwise the first offered model.
   */
  setPreferredModel(id: string | null): Promise<void>;
}
