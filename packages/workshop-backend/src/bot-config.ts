// Declared bots (see the Bot* types in @gadgets/workshop-shared/api): a pure module for the
// shape of a bot's declaration, the system-prompt section a bot chat runs with, and the
// ambient-catalog dedup that keeps a bot's skills out of the catalogs it also lists them in.
// Pure like agent-catalog.ts: no storage, no hooks, no I/O, so it is trivially testable and safe
// to call from anywhere (the user DO validating a declaration, the overseer snapshotting a chat).

import {
  MAX_BOT_DESCRIPTION_LENGTH, MAX_BOT_INSTRUCTIONS_LENGTH, MAX_BOT_NAME_LENGTH, MAX_BOT_SKILLS,
  type BotDefinition, type BotSelection, type BotSkillRef,
} from "@gadgets/workshop-shared/api";
import type { AlwaysAvailableResource, WorkpieceId } from "@gadgets/workshop-shared/api";
import type { AgentCatalog } from "@gadgets/workshop-shared/gatekeeper";

/** The resolved form of one skill a bot chat may activate, as stored on the chat's context. */
export type ResolvedBotSkill = {
  /** The workpiece offering the command; with `commandId`, what invokeBotSkill re-resolves. */
  gatekeeperId: WorkpieceId;

  /** The command as that workpiece's provider names it. */
  commandId: string;

  /** Display title, shown in the prompt's skill list. */
  title: string;

  /** What the skill does, shown in the prompt's skill list. */
  description: string;
};

/** A skill a bot declared that the workspace could not resolve (recorded, never dropped silently). */
export type UnavailableBotSkill = {
  vendorId: string;
  commandId: string;
  name: string;
};

/** Single-line normalization for names, descriptions and identifiers: control chars out, spaces collapsed. */
function normalizeSingleLine(value: string, maxLength: number): string {
  return value.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/** Multi-line normalization for instructions: control chars out except newlines, spaces collapsed. */
function normalizeMultiLine(value: string, maxLength: number): string {
  return value.replace(/\p{Cc}/gu, c => c === "\n" ? c : " ")
      .replace(/[^\S\n]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .trim()
      .slice(0, maxLength);
}

/**
 * Validate and normalize a bot declaration, from a client (whose RPC arguments capnweb has
 * already checked against BotDefinition) or from stored admin config (whose shape nothing
 * vouches for — hence the runtime checks). Throws on input that is not a usable declaration
 * (missing name, model or instructions' shape, a field over its cap, a skill without vendor or
 * command); trims and collapses whitespace, and drops duplicate skills by vendorId+commandId.
 * Storage readers that must not throw (the admin-config KV mirror) catch and drop the entry,
 * like they do for malformed stored entries elsewhere.
 */
export function normalizeBotDefinition(value: unknown): BotDefinition {
  if (typeof value !== "object" || value === null) throw new Error("A bot declaration is required.");
  // Widening after the object check: every field read below is checked before use.
  let bot = value as Record<string, unknown>;
  if (typeof bot.name !== "string") throw new Error("A bot needs a name.");
  let name = normalizeSingleLine(bot.name, MAX_BOT_NAME_LENGTH + 1);
  if (!name) throw new Error("A bot needs a name.");
  if (bot.name.length > MAX_BOT_NAME_LENGTH) {
    throw new Error(`A bot's name may be at most ${MAX_BOT_NAME_LENGTH} characters.`);
  }
  let description: string | undefined = undefined;
  if (bot.description !== undefined) {
    if (typeof bot.description !== "string") throw new Error("A bot's description must be text.");
    if (bot.description.length > MAX_BOT_DESCRIPTION_LENGTH) {
      throw new Error(`A bot's description may be at most ${MAX_BOT_DESCRIPTION_LENGTH} characters.`);
    }
    description = normalizeSingleLine(bot.description, MAX_BOT_DESCRIPTION_LENGTH) || undefined;
  }
  if (typeof bot.instructions !== "string") throw new Error("A bot needs instructions.");
  if (bot.instructions.length > MAX_BOT_INSTRUCTIONS_LENGTH) {
    throw new Error(`A bot's instructions may be at most ${MAX_BOT_INSTRUCTIONS_LENGTH} characters.`);
  }
  let instructions = normalizeMultiLine(bot.instructions, MAX_BOT_INSTRUCTIONS_LENGTH);
  if (typeof bot.modelId !== "string") throw new Error("A bot needs a model.");
  let modelId = normalizeSingleLine(bot.modelId, 200);
  if (!modelId) throw new Error("A bot needs a model.");
  let skills: BotSkillRef[] = [];
  if (bot.skills !== undefined) {
    if (!Array.isArray(bot.skills)) throw new Error("A bot's skills must be a list.");
    if (bot.skills.length > MAX_BOT_SKILLS) {
      throw new Error(`A bot may declare at most ${MAX_BOT_SKILLS} skills.`);
    }
    let seen = new Set<string>();
    for (let skill of bot.skills) {
      if (typeof skill !== "object" || skill === null) {
        throw new Error("Every skill a bot declares needs a vendor and a command.");
      }
      // Widening after the object check: the three fields are checked before use.
      let ref = skill as Record<string, unknown>;
      if (typeof ref.vendorId !== "string" || typeof ref.commandId !== "string") {
        throw new Error("Every skill a bot declares needs a vendor and a command.");
      }
      let vendorId = normalizeSingleLine(ref.vendorId, 200);
      let commandId = normalizeSingleLine(ref.commandId, 200);
      if (!vendorId || !commandId) {
        throw new Error("Every skill a bot declares needs a vendor and a command.");
      }
      let skillName = typeof ref.name === "string" ? normalizeSingleLine(ref.name, 200) : "";
      let dedupeKey = `${vendorId}\u0000${commandId}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      skills.push({vendorId, commandId, name: skillName || commandId});
    }
  }
  return {name, description, instructions, modelId, skills};
}

/**
 * The canonical string form of a BotSelection, used where a bot's identity must be one token:
 * delegation chains, tool input, and the author id of messages a bot sends ("u:3", "d:writer").
 */
export function botKey(selection: BotSelection): string {
  return selection.scope === "user" ? `u:${selection.id}` : `d:${selection.id}`;
}

/** The BotSelection a botKey() string names, or undefined if it is not one. */
export function parseBotKey(key: string): BotSelection | undefined {
  if (key.startsWith("u:") && key.length > 2) return {scope: "user", id: key.slice(2)};
  if (key.startsWith("d:") && key.length > 2) return {scope: "deployment", id: key.slice(2)};
  return undefined;
}

/**
 * The system-prompt section a bot chat carries: the bot's identity, standing instructions, and
 * skills (which the model activates on demand, never baked-in text). Appended to the
 * environment slot (slot 1) after the always-available resources, so the static slot 0 keeps its
 * cross-chat cache prefix. Returns "" for a chat with no bot.
 */
export function formatBotSection(
    bot: {name: string; description?: string; instructions: string},
    skills: ResolvedBotSkill[],
    unavailable: UnavailableBotSkill[]): string {
  let lines: string[] = [`# Bot: ${bot.name}`];
  if (bot.description) lines.push("", bot.description);
  lines.push("", "## Instructions", "", bot.instructions);
  if (skills.length > 0) {
    lines.push("", "## Skills", "",
        ...skills.map(skill =>
            `- ${skill.title} — ${skill.description} (activate with the activateSkill tool: "${skill.commandId}")`));
  }
  if (unavailable.length > 0) {
    lines.push("", "## Skills not available in this workspace", "",
        ...unavailable.map(skill => `- ${skill.name} (${skill.vendorId}:${skill.commandId})`));
  }
  return lines.join("\n");
}

/**
 * A bot's skills appear only in its bot section, never again in the ambient catalogs, so a
 * workspace whose Context singleton the bot also lists skills from does not show them twice.
 * Strips from each resource's catalog the entries the bot's resolved skills name — matched by the
 * workpiece offering them (the seed binding's target) and the entry's id — and drops a resource
 * left with an empty catalog. `seedTargets` maps each resource's binding name to its workpiece
 * (built from the chat's seed bindings). Pure: callers apply it as a per-turn derived filter and
 * never persist the filtered set, so a bot switch cannot serve a stale one.
 */
export function dedupCatalogsForBot(
    resources: AlwaysAvailableResource[],
    seedTargets: ReadonlyMap<string, WorkpieceId>,
    botSkills: readonly {gatekeeperId: WorkpieceId; commandId: string}[]): AlwaysAvailableResource[] {
  if (botSkills.length === 0) return resources;
  let skillKeys = new Set(botSkills.map(skill => `${skill.gatekeeperId}\u0000${skill.commandId}`));
  return resources.flatMap(resource => {
    let target = seedTargets.get(resource.name);
    if (target === undefined || resource.catalog === null) return [resource];
    let entries = resource.catalog.entries.filter(
        entry => !skillKeys.has(`${target}\u0000${entry.id}`));
    if (entries.length === resource.catalog.entries.length) return [resource];
    if (entries.length === 0) return [];
    let catalog: AgentCatalog = {...resource.catalog, entries};
    return [{...resource, catalog}];
  });
}
