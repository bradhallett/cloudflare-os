import type { AiChatMessage } from "@gadgets/workshop-shared/api";
import type { WorkpieceId } from "@gadgets/workshop-shared/api";
import type { ChatBindingEntry } from "./storage-schema/overseer-storage";

/**
 * The chat's binding map and everything derived from replaying the chat log over it: the ONE
 * walk that decides which names a message log binds, claims, or reserves.
 *
 * Three callers previously maintained three private copies of this walk -- the agent's turn
 * replay (agent-replay.ts), the turn-start naming chokepoint (overseer-bindings.ts), and compaction
 * (agent-compaction.ts) -- which had drifted apart. All three now seed a
 * {@link ChatBindingScope} and fold messages through {@link applyMessageBindings}, so the
 * semantics live here exactly once:
 *
 * - Pasted resources (capsules) and "changes" declarations bind first-wins by name: a name
 *   already bound keeps its target.
 * - createGadget / createWorktree / createExternalResource tool calls take their input name
 *   even when the call failed (the name appears in the log the model reads), but bind only on
 *   success -- and a successful creation rebinds its name unconditionally, since a creation
 *   tool always mints a fresh workpiece.
 * - An agentCallback binds its arguments as a value binding under the name stamped when the
 *   call was appended; a message without one predates durable calls and binds nothing.
 * - A pending connection request claims its name (reserved but resolving to nothing yet); an
 *   accepted one binds first-wins; a denied one releases the claim -- the name was never the
 *   resource's, and a later arrival may take it. (Connection request messages are mutated in
 *   place to their final state, so a walk normally sees either pending or resolved, never
 *   both; release keeps the walk correct if a future message type ever sequences them.)
 *
 * The walk is deterministic in log order, so replay, naming, and compaction reconstruct the
 * same scope from the same prefix.
 */

/** The mutable scope one walk accumulates into. See the module comment for the semantics. */
export class ChatBindingScope {
  /** Name -> binding, in insertion (log) order. */
  readonly bindings = new Map<string, ChatBindingEntry>();

  /**
   * Names claimed by connection requests that are still pending: reserved from request time
   * (so nothing else takes the name before acceptance) but resolving to nothing yet.
   */
  readonly claimed = new Set<string>();

  /**
   * Reverse index for naming: the first name bound to each workpiece target, so a later
   * unnamed arrival for the same target reuses it instead of allocating a second name.
   */
  readonly nameByTarget = new Map<WorkpieceId, string>();

  /**
   * Every name the log puts in the chat's scope, bound or merely reserved: what a naming pass
   * must avoid when allocating a fresh name. Wider than `bindings`/`claimed` because a failed
   * creation tool's input name is taken without binding anything.
   */
  readonly taken = new Set<string>();

  /**
   * Seed the scope from the chat's seed layer and compaction checkpoint entries (either order;
   * conflicts cannot arise because a checkpoint folds the seed it started from). Entry names
   * are taken, and workpiece entries populate the naming reverse index, first-wins.
   */
  constructor(entries: Iterable<[string, ChatBindingEntry]> = []) {
    for (let [name, entry] of entries) {
      this.bindIfAbsent(name, entry);
    }
  }

  /** Bind `name` unless something already holds it (capsules, accepted connections, changes). */
  bindIfAbsent(name: string, entry: ChatBindingEntry): void {
    if (this.bindings.has(name)) return;
    this.bindings.set(name, entry);
    this.taken.add(name);
    this.#index(name, entry);
  }

  /**
   * Bind `name` unconditionally (a successful creation, or an agentCallback's arguments): the
   * name is being (re)pointed at a fresh target, but earlier names keep their reverse index.
   */
  rebind(name: string, entry: ChatBindingEntry): void {
    this.bindings.set(name, entry);
    this.taken.add(name);
    this.#index(name, entry);
  }

  /** Reserve `name` for a pending connection request (see {@link claimed}). */
  claim(name: string): void {
    this.claimed.add(name);
    this.taken.add(name);
  }

  /** Release a denied request's claim: the name binds nothing and is free again. */
  release(name: string): void {
    this.claimed.delete(name);
    if (!this.bindings.has(name)) this.taken.delete(name);
  }

  /** Whether `name` is unavailable for a new chat binding (excluding the automatic env.GIT). */
  inScope(name: string): boolean {
    return this.bindings.has(name) || this.claimed.has(name);
  }

  /**
   * The chat env name for a workpiece, if the scope holds one. A scan in insertion order, so
   * the first name bound to a target wins -- including names added by later rebinding, which
   * the {@link nameByTarget} index deliberately does not track (it serves naming reuse only).
   */
  nameFor(id: WorkpieceId): string | undefined {
    for (let [name, entry] of this.bindings) {
      if (entry.type === "workpiece" && entry.id === id) return name;
    }
    return undefined;
  }

  #index(name: string, entry: ChatBindingEntry): void {
    if (entry.type === "workpiece" && !this.nameByTarget.has(entry.id)) {
      this.nameByTarget.set(entry.id, name);
    }
  }
}

/**
 * Fold one chat log message into the scope, applying the walk's semantics (see the module
 * comment). Callers hand messages over in log order; a compaction boundary just starts the
 * walk from the checkpoint instead of replaying the prefix.
 */
export function applyMessageBindings(scope: ChatBindingScope, message: AiChatMessage): void {
  if (message.type === "message") {
    for (let capsule of message.capsules ?? []) {
      if (capsule.bindingName !== undefined) {
        scope.bindIfAbsent(capsule.bindingName,
            {type: "workpiece", id: capsule.gatekeeperId});
      }
    }
    for (let call of message.toolCalls ?? []) {
      if (call.toolName !== "createGadget" && call.toolName !== "createWorktree" &&
          call.toolName !== "createExternalResource") {
        continue;
      }
      // The input name is part of the log either way; only a success binds (and the tool
      // guarantees a recorded output on success).
      if (!call.error && call.output !== undefined) {
        let id = call.toolName === "createGadget" ? call.output.gadgetId
            : call.toolName === "createWorktree" ? call.output.worktreeId
            : call.output.gatekeeperId;
        scope.rebind(call.input.bindingName, {type: "workpiece", id});
      } else {
        scope.taken.add(call.input.bindingName);
      }
    }
  } else if (message.type === "agentCallback") {
    if (message.bindingName !== undefined) {
      scope.rebind(message.bindingName, {type: "value", messageSequence: message.sequence});
    }
  } else if (message.type === "connectionRequest") {
    if (message.bindingName === undefined) return;
    if (message.state === "pending") {
      scope.claim(message.bindingName);
    } else if (message.state === "accepted") {
      scope.taken.add(message.bindingName);
      if (message.gatekeeperId !== undefined) {
        scope.bindIfAbsent(message.bindingName, {type: "workpiece", id: message.gatekeeperId});
      }
    } else {
      scope.release(message.bindingName);
    }
  } else if (message.type === "changes") {
    for (let {gadgetId, bindingName} of message.createdGadgets ?? []) {
      scope.bindIfAbsent(bindingName, {type: "workpiece", id: gadgetId});
    }
    for (let {worktreeId, bindingName} of message.createdWorktrees ?? []) {
      scope.bindIfAbsent(bindingName, {type: "workpiece", id: worktreeId});
    }
  }
}
