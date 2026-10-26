import type { LiveChatContext } from "./overseer-support";

/**
 * The in-memory registries of a workspace's live chat state: each chat's {@link LiveChatContext},
 * the single-flight drains of pending agent calls, and the delegateToBot subagent waiters.
 *
 * Extracted from OverseerCore's protected fields (WorkshopCore MAJOR 4): registry-shaped state
 * lives in a collaborator rather than another inheritance layer, so the chain's layers reach it
 * only through this object's surface instead of through shared protected fields any layer could
 * re-shape. Everything here is per-DO-session and never persisted.
 */
export class LiveChatState {
  /** Fires whenever a pending-call drain settles, however it ends — the hook that lets the core's
   * waitForAllAgentsToComplete waiters re-check their conditions (a drain can settle without
   * starting a turn, which unregistering a running agent never observes). */
  #onDrainSettled: () => void;

  #liveChats = new Map<number, LiveChatContext>();
  #pendingCallDrains = new Map<number, Promise<void>>();
  #subagentWaiters = new Map<number, Set<() => void>>();

  constructor(onDrainSettled: () => void) {
    this.#onDrainSettled = onDrainSettled;
  }

  /** The chat's live context, or undefined while it has none this DO session. */
  get(chatId: number): LiveChatContext | undefined {
    return this.#liveChats.get(chatId);
  }

  /** The chat's live context, creating it (a fresh cancel controller) the first time it is asked
   * for — the identity a running turn compares against to tell a later context from its own. */
  getOrCreate(chatId: number): LiveChatContext {
    let ctx = this.#liveChats.get(chatId);
    if (!ctx) {
      ctx = {
        cancelController: new AbortController(),
      };
      this.#liveChats.set(chatId, ctx);
    }
    return ctx;
  }

  /** Drops the chat's live context, so the next turn (or drain) builds a fresh one. */
  delete(chatId: number): void {
    this.#liveChats.delete(chatId);
  }

  /** Every chat that currently holds a live context (a copy: callers may destroy through it). */
  chatIds(): number[] {
    return [...this.#liveChats.keys()];
  }

  /** Whether any pending-agent-call drain is still in flight (see {@link drain}). */
  hasDrains(): boolean {
    return this.#pendingCallDrains.size > 0;
  }

  /**
   * Single-flight drain per chat: a kick while a drain is already in flight joins it rather than
   * starting another (`start` runs only when none is in flight, and re-lists the records after
   * its awaits, so it picks up anything recorded meanwhile). This is what lets runAlarmTasks see
   * a drain as work in progress, and keeps the constructor and the alarm handler, which may both
   * kick the same chat, from resolving the model twice or reporting a failure twice. When the
   * drain settles the registry entry goes and the `onDrainSettled` hook fires.
   */
  drain(chatId: number, start: () => Promise<void>): Promise<void> {
    let existing = this.#pendingCallDrains.get(chatId);
    if (existing) return existing;
    let drain = start().finally(() => {
      this.#pendingCallDrains.delete(chatId);
      this.#onDrainSettled();
    });
    this.#pendingCallDrains.set(chatId, drain);
    return drain;
  }

  /**
   * Registers one delegateToBot await on the *child* chat's turn end and resolves with it (see
   * runBotSubagent): every turn-terminal path calls {@link resolveSubagents}, so however the
   * child's turn ends — reply, error, approval park, abort — the parent's tool call resolves.
   * Re-armed by the parent re-executing the tool call after a reset, alongside the durable
   * pendingDelegations record that makes the await survive DO restarts.
   */
  armSubagentWaiter(childChatId: number): Promise<void> {
    let waiter = Promise.withResolvers<void>();
    let waiters = this.#subagentWaiters.get(childChatId) ?? new Set();
    waiters.add(() => waiter.resolve());
    this.#subagentWaiters.set(childChatId, waiters);
    return waiter.promise;
  }

  /** Resolves however the chat's turn ends: wakes every delegateToBot await keyed to it. The
   * durable pendingDelegations records are marked done by the caller that owns storage. */
  resolveSubagents(chatId: number): void {
    let waiters = this.#subagentWaiters.get(chatId);
    if (waiters) {
      this.#subagentWaiters.delete(chatId);
      for (let waiter of waiters) waiter();
    }
  }
}
