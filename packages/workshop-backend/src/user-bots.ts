import type { BotDefinition, BotSelection, BotSkillRef } from "@gadgets/workshop-shared/api";
import { readAdminConfig } from "./admin-config.js";
import { botKey, normalizeBotDefinition } from "./bot-config.js";
import type { StoredBotRecord, UserStorage } from "./storage-schema/user-storage.js";

/**
 * A declared bot as resolved for a chat: its selection plus its definition, which is normalized
 * where it is stored (the user's bots at create/update, deployment bots in admin config). This is
 * the identity a chat snapshots at start; it is not re-resolved per turn, so a later edit or
 * deletion never rewrites a running chat.
 */
export type ResolvedUserBot = {
  selection: BotSelection;
  name: string;
  description?: string;
  instructions: string;
  modelId: string;
  skills: BotSkillRef[];
};

/**
 * The user's declared-bot store: CRUD over the `bots` storage slice plus resolution of a
 * BotSelection to the declaration it names. Extracted from UserDurableObject so the bots
 * product area owns its storage slice; the DO keeps the model-availability views (listBots)
 * and the account-coupled skill listing, which read the AI model catalog and connected
 * accounts rather than this storage.
 */
export class UserBotStore {
  #env: Cloudflare.Env;
  #storage: Pick<UserStorage, "bots" | "nextBotId">;

  constructor(env: Cloudflare.Env, storage: Pick<UserStorage, "bots" | "nextBotId">) {
    this.#env = env;
    this.#storage = storage;
  }

  /** The user's own bot records, as stored (the deployment's bots are listBots' metadata). */
  list(): StoredBotRecord[] {
    return [...this.#storage.bots.list()];
  }

  /** One of this user's own bots' definitions, as stored. */
  get(id: string): BotDefinition {
    let record = this.#storage.bots.get(id);
    if (!record) throw new Error(`No such bot: ${botKey({scope: "user", id})}`);
    return record.def;
  }

  /**
   * Create a bot owned by this user, returning its id. The name must be unique among the user's
   * own bots; the definition is capped and trimmed by normalizeBotDefinition.
   */
  create(def: BotDefinition): string {
    let normalized = normalizeBotDefinition(def);
    this.#assertNameFree(normalized.name);
    let next = this.#storage.nextBotId.get();
    this.#storage.nextBotId.put(next + 1);
    this.#storage.bots.put({id: String(next), def: normalized, created: new Date()});
    return String(next);
  }

  /**
   * Replace one of this user's own bots' definitions, keeping its id (and so every chat's
   * selection of it) stable.
   */
  update(id: string, def: BotDefinition): void {
    let record = this.#storage.bots.get(id);
    if (!record) throw new Error(`No such bot: ${botKey({scope: "user", id})}`);
    let normalized = normalizeBotDefinition(def);
    this.#assertNameFree(normalized.name, id);
    record.def = normalized;
    this.#storage.bots.put(record);
  }

  /**
   * Delete one of this user's own bots. Chats that used it keep their frozen snapshot, so this
   * is a no-op on an already-deleted bot.
   */
  delete(id: string): void {
    this.#storage.bots.delete(id);
  }

  /**
   * The declaration a BotSelection names: the user's own bots from storage, the deployment's
   * from the admin config's KV mirror (normalized where it is stored). A bot that no longer
   * exists throws visibly (`No such bot: <key>`) rather than degrading to a bare-model chat,
   * which would silently run a different agent than the one picked.
   */
  async resolve(selection: BotSelection): Promise<ResolvedUserBot> {
    if (selection.scope === "user") {
      let record = this.#storage.bots.get(selection.id);
      if (!record) throw new Error(`No such bot: ${botKey(selection)}`);
      return {selection, ...record.def};
    }
    let deployment = (await readAdminConfig(this.#env)).deploymentBots
        .find(bot => bot.id === selection.id);
    if (!deployment) throw new Error(`No such bot: ${botKey(selection)}`);
    return {selection, ...deployment.def};
  }

  // Bot names are unique among the user's own bots (deployment bots are a separate namespace;
  // cross-scope collisions are disambiguated by the bot key, never by refusing the name).
  // `exceptId` keeps an updated bot's own record out of the check.
  #assertNameFree(name: string, exceptId?: string): void {
    for (let other of this.#storage.bots.list()) {
      if (other.id !== exceptId && other.def.name === name) {
        throw new Error(`You already have a bot named "${name}".`);
      }
    }
  }
}
