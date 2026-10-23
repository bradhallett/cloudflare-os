import { RpcStub } from "capnweb";
import { WorkpieceId, WorkpieceSummary, WorkpiecesSubscriber, ChatCodeBase, AiChatMetadata, AiChatSubscriber, AiChatAuthorInfo, CapsuleSpecifier, CollaboratorRole, BlueprintOutput, AiChatStreamEvent, ChatAttachmentRef, PresenceParticipant, PresenceSubscriber, validateBindingName } from "@gadgets/workshop-shared/api";
import type { FileContent, CodeContent, CodeChange } from "@gadgets/workshop-shared/code-change";
import { RpcStub as NativeRpcStub } from "cloudflare:workers";
import { chatKeyPrefix, makeOverseerStorage } from "./storage-schema/overseer-storage";
import type { BindingRecord, ChatChangeRecord, ExternalMessageRecord, GadgetRecord, OverseerStorage, WorkpieceRecord, WorktreeRecord } from "./storage-schema/overseer-storage";
import { GitStore } from "./git-store";
import { WorkspaceGitCache } from "./git-cache";
import type { WorktreeTurnAccess } from "./agent";
import { scanWorkpieceForGrep } from "./grep";
import type { GrepScan } from "./grep";
import { isTurnPrompt } from "./agent-compaction";
import { UserDurableObject } from "./user";
import { recordAnalytics } from "./analytics";
import type { ProductAnalyticsGadgetInput } from "./analytics";
import { AutoApprovalDrainer } from "./auto-approval";
import { createWorkshopLogger } from "./observability";
import type { LiveChatContext, SessionKind } from "./overseer-support";
import { AGENT_KEEPALIVE_ALARM_MS, AGENT_RESPONSE_DELIVERED_RETENTION_MS, CHAT_CHANGE_RETIRED_TTL_MS } from "./overseer-support";
import { ChatCacheWarmer } from "./chat-cache-warming";
import { CHAT_ATTACHMENT_EXTENSION_BY_MIME } from "./overseer-chat-attachments";
import type { OverseerImpl } from "./overseer-impl";

const logger = createWorkshopLogger("workshop.overseer");

/**
 * OverseerCore: core state (storage/git/user fields), presence, chat subscribers, and gadget/workpiece primitives.
 *
 * Part of the partial-class chain backing OverseerImpl (overseer-impl.ts), split out of
 * the former single-file overseer.ts. This layer only depends on layers before it.
 */
export abstract class OverseerCore {
  constructor(public ctx: DurableObjectState, public env: Cloudflare.Env) {
    this.logger = logger.with({ gadgetId: ctx.id.toString() });
    this.storage = makeOverseerStorage(ctx.storage);
    this.gitStore = new GitStore(this.storage.gitObjects);
    this.users = this.ctx.exports.UserDurableObject;
    this.ownerId = this.storage.ownerId.get();
  }
  public storage: OverseerStorage;

  readonly logger: ReturnType<typeof createWorkshopLogger>;

  /**
   * Identifies this DO instance. Sent to chat subscribers so they can detect a full server
   * restart (see AiChatSubscriber.streamGeneration). A timestamp suffices since a DO won't
   * restart and begin serving requests twice within the same millisecond.
   */
  readonly streamGeneration = Date.now();

  /** If not set, this gadget doesn't exist yet. */
  ownerId?: string;

  /**
   * Cached from storage, initialized during the constructor, since it is referenced often but
   * almost never changes.
   */
  defaultGadgetId?: WorkpieceId;

  /**
   * The owner's profile.id (username/email). Cached in memory (not persisted) for use
   * in permission graph calculations. Populated when the owner calls open(), or lazily
   * via an RPC to the owner's UserDO when needed.
   */
  ownerProfileId?: string;

  users: DurableObjectNamespace<UserDurableObject>;

  /**
   * The workspace's git object store, holding all gadgets' committed code (see git-store.ts).
   * One instance per DO so isomorphic-git's parse cache is shared.
   */
  readonly gitStore: GitStore;

  /**
   * The gatekeeper-facing git cache layer over the same store: provenance metadata, the pull
   * driver, and push authorization (see git-cache.ts). Per-gatekeeper GitCache stubs are minted
   * from this via `new GitCacheImpl(...)`.
   */
  gitCache!: WorkspaceGitCache;

  /** Per-chat in-memory state for running agents. */
  protected liveChats = new Map<number, LiveChatContext>();

  #chatSubscribers: Set<RpcStub<AiChatSubscriber>> = new Set();

  protected autoApprovalDrainer!: AutoApprovalDrainer;

  protected preparingChatMessages = new Map<number, Promise<void>>();

  /**
   * Set of chatIds that currently have a running agent turn. Feeds the alarm (see
   * #agentKeepAliveTime) and lets `alarm()` wait for all agents to finish.
   */
  protected runningAgents = new Set<number>();

  /**
   * A failed replay-safe model lookup hands the existing row back to the alarm. Its attempt
   * budget lives on that row, since another concern can reschedule the shared alarm.
   */
  protected resumeErrors = new Map<number, unknown>();

  // If `alarm()` is currently waiting for all agents to finish, this resolves its wait. Invoked
  // when the running-agent count drops to zero.
  #allAgentsIdleWaiters: (() => void)[] = [];

  /**
   * While agent work is outstanding -- a running turn, or a recorded call to a callable agent not
   * yet appended to its chat (see `pendingAgentCalls`) -- the time from which we can no longer
   * count on a client event to keep the DO alive, and so need an alarm handler running to do it
   * instead. Set when such work first becomes outstanding, cleared when none remains, and
   * otherwise held fixed: a recompute must not push it out, or the handler could start too late.
   * The same alarm also wakes the DO if it died meanwhile (the constructor then resumes the turns
   * and drains the calls before alarm() runs). While the DO is alive and busy the work itself
   * keeps it up, so the alarm typically fires only in the two cases it exists for. See
   * #updateAlarm.
   */
  protected agentKeepAliveTime?: number;

  /** True while alarm() runs (see runAlarmTasks); #updateAlarm defers to its end. */
  protected inAlarmHandler = false;

  protected scheduledAlarm: number | null | undefined;

  /** Drains of pending agent calls currently in flight, by chat (see drainPendingAgentCalls). */
  protected pendingCallDrains = new Map<number, Promise<void>>();

  /**
   * Chats with a delegateToBot call awaiting a subagent's turn (see runBotSubagent), keyed by
   * the *child* chat: every turn-terminal path calls settleSubagentWaiters(chatId), so however
   * the child's turn ends -- reply, error, approval park, abort -- the parent's tool call
   * resolves. Rebuilt from the durable pendingDelegations record when a reset re-executes the
   * tool call, so the await survives DO restarts.
   */
  protected subagentWaiters = new Map<number, Set<() => void>>();

  /**
   * Resolve however the chat's turn ends: wake every delegateToBot await keyed to it and mark
   * its delegation records done (the await re-arms if the parent re-executes the tool call).
   */
  protected settleSubagentWaiters(chatId: number): void {
    let waiters = this.subagentWaiters.get(chatId);
    if (waiters) {
      this.subagentWaiters.delete(chatId);
      for (let waiter of waiters) waiter();
    }
    for (let record of this.storage.pendingDelegations.byChildChatId.get(chatId)) {
      if (!record.done) this.storage.pendingDelegations.put({...record, done: true});
    }
  }

  /** Keeps a viewed chat's last model request warm between turns (see chat-cache-warming.ts). */
  cacheWarmer!: ChatCacheWarmer;

  addChatSubscriber(subscriber: RpcStub<AiChatSubscriber>) {
    this.#chatSubscribers.add(subscriber);
  }

  removeChatSubscriber(subscriber: RpcStub<AiChatSubscriber>) {
    this.#chatSubscribers.delete(subscriber);
  }

  /**
   * Active viewers, keyed by profileId. Multiple sessions from the same user collapse into one
   * participant.
   */
  protected presence = new Map<string, {
    key: string;
    user: AiChatAuthorInfo;
    sessions: Map<object, CollaboratorRole>;
  }>();

  /** Subscribers to roster changes, registered via subscribeToPresence(). */
  protected presenceSubscribers = new Map<object, RpcStub<PresenceSubscriber>>();

  #presenceKeyCounter = 0;

  #effectivePresenceRole(sessions: Map<object, CollaboratorRole>): CollaboratorRole {
    for (let role of sessions.values()) {
      if (role === "build") return "build";
    }
    return "use";
  }

  #toParticipant(profileId: string): PresenceParticipant {
    let entry = this.presence.get(profileId)!;
    return { key: entry.key, user: entry.user, role: this.#effectivePresenceRole(entry.sessions) };
  }

  #broadcastPresenceAdd(participant: PresenceParticipant) {
    for (let [token, sub] of this.presenceSubscribers) {
      sub.add(participant).catch(() => this.#removePresenceSubscriber(token));
    }
  }

  #broadcastPresenceRemove(key: string) {
    for (let [token, sub] of this.presenceSubscribers) {
      sub.remove(key).catch(() => this.#removePresenceSubscriber(token));
    }
  }

  /** Mark a session as present. Returns a function that removes it. */
  joinPresence(profileId: string, user: AiChatAuthorInfo, role: CollaboratorRole): () => void {
    let token = {};
    let entry = this.presence.get(profileId);
    if (entry) {
      let before = this.#effectivePresenceRole(entry.sessions);
      entry.sessions.set(token, role);
      if (this.#effectivePresenceRole(entry.sessions) !== before) {
        this.#broadcastPresenceAdd(this.#toParticipant(profileId));
      }
    } else {
      this.presence.set(profileId,
          { key: `p${++this.#presenceKeyCounter}`, user, sessions: new Map([[token, role]]) });
      this.#broadcastPresenceAdd(this.#toParticipant(profileId));
    }

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      let e = this.presence.get(profileId);
      if (!e) return;
      let before = this.#effectivePresenceRole(e.sessions);
      e.sessions.delete(token);
      if (e.sessions.size === 0) {
        this.presence.delete(profileId);
        this.#broadcastPresenceRemove(e.key);
      } else if (this.#effectivePresenceRole(e.sessions) !== before) {
        this.#broadcastPresenceAdd(this.#toParticipant(profileId));
      }
    };
  }

  // Live counts of everything a collaborator holds (or is about to hold) a role's access through,
  // maintained by joinSession(): the client interfaces, the capabilities minted into their
  // sessions -- which the client can retain past the interface's disposal -- and in-flight
  // authorizations, which are sessions-to-be parked on collaborator-controlled awaits.
  #liveSessions: Record<SessionKind, number> = {owner: 0, build: 0, use: 0};

  /**
   * Count a session for its lifetime. Returns a function that uncounts it, like joinPresence().
   *
   * Deliberately not derived from #presence, which looks like it holds the same thing: a session
   * joins presence only once its fetchProfile() resolves, so a just-opened session is briefly
   * invisible there. That is fine for a roster and wrong for an access decision, which must never
   * conclude "nobody is here" about a session that already exists.
   */
  joinSession(kind: SessionKind): () => void {
    this.#liveSessions[kind]++;
    let left = false;
    return () => {
      if (left) return;
      left = true;
      this.#liveSessions[kind]--;
    };
  }

  /**
   * Whether some non-owner session of `role` (or of any role, when omitted) is live right now.
   * The owner is never an observer, so their session never counts here.
   */
  protected hasCollaboratorSession(role?: CollaboratorRole): boolean {
    if (role !== undefined) return this.#liveSessions[role] > 0;
    return Object.entries(this.#liveSessions).some(([kind, n]) => kind !== "owner" && n > 0);
  }

  /** Subscribe to roster changes. The current roster is delivered immediately via init(). */
  addPresenceSubscriber(subscriber: RpcStub<PresenceSubscriber>): RpcStub<{}> {
    subscriber = subscriber.dup();
    let token = {};
    this.presenceSubscribers.set(token, subscriber);
    let snapshot = [...this.presence.keys()].map(id => this.#toParticipant(id));
    subscriber.init(snapshot).catch(() => this.#removePresenceSubscriber(token));
    subscriber.onRpcBroken(() => this.#removePresenceSubscriber(token));
    // @ts-expect-error Bugs in native RPC types make this not work currently.
    return new NativeRpcStub<{}>({
      [Symbol.dispose]: () => this.#removePresenceSubscriber(token),
    });
  }

  #removePresenceSubscriber(token: object) {
    let sub = this.presenceSubscribers.get(token);
    if (!sub) return;
    this.presenceSubscribers.delete(token);
    sub[Symbol.dispose]();
  }

  protected getLiveChat(chatId: number): LiveChatContext {
    let ctx = this.liveChats.get(chatId);
    if (!ctx) {
      ctx = {
        cancelController: new AbortController(),
      };
      this.liveChats.set(chatId, ctx);
    }
    return ctx;
  }

  /**
   * Register a newly-started (or resumed) agent turn. Called at the start of `startAgent` /
   * `#resumeAgent`, in the same synchronous step that sets `chatMeta.activeAgent` and writes the
   * `activeAgents` record, so that the three representations of "an agent is running for this chat"
   * stay consistent. `#unregisterRunningAgent` performs the matching teardown.
   */
  protected registerRunningAgent(chatId: number) {
    this.runningAgents.add(chatId);
    this.updateAlarm();
    // The turn's own requests keep the cache warm, and its end warms its last request instead.
    this.cacheWarmer.end(chatId, "turn");
  }

  /**
   * Release a running execution and recompute the alarm. A decision pause or retryable model
   * lookup retains the existing record; completion deletes it. MUST be called
   * synchronously together with clearing `chatMeta.activeAgent`. An idle retained row is only
   * the original authority for the log's current decision; starting new work replaces it.
   */
  protected unregisterRunningAgent(chatId: number, retainRecord = false) {
    this.runningAgents.delete(chatId);
    if (!retainRecord) this.storage.activeAgents.delete(chatId);
    this.updateAlarm();
    if (this.runningAgents.size === 0) {
      this.wakeIdleWaiters();
    }
  }

  /**
   * Rouses waitForAllAgentsToComplete's waiters to re-check their conditions. Waking is always
   * safe: a waiter whose condition still holds (an agent still running, a drain still in flight)
   * re-arms itself.
   */
  protected wakeIdleWaiters(): void {
    for (let waiter of this.#allAgentsIdleWaiters) {
      waiter();
    }
    this.#allAgentsIdleWaiters = [];
  }

  /**
   * This DO has one alarm, and this is its only writer: the alarm is the earliest of the times at
   * which some concern needs the handler to run, and alarm() then handles all of them. Call it
   * after changing any state a concern derives from; a concern that recomputes to the same time
   * is a harmless re-set, and none can clobber another.
   *
   * A no-op while the handler itself is running: the DO is alive for as long as that lasts, and
   * runAlarmTasks recomputes once, from a settled state, when it ends. `notBefore` backs off a
   * fresh alarm after the platform's retries are exhausted.
   */
  protected updateAlarm(notBefore = 0): void {
    if (this.inAlarmHandler) return;

    let times: number[] = [];

    // Outstanding agent work: see #agentKeepAliveTime for why it is set once and held.
    let hasAgentWork = this.runningAgents.size > 0 ||
        [...this.storage.activeAgents.list()].some(r => this.storage.chatMeta.get(r.chatId)?.activeAgent) ||
        Array.from(this.storage.pendingAgentCalls.list({ limit: 1 })).length > 0;
    if (!hasAgentWork) {
      this.agentKeepAliveTime = undefined;
    } else {
      this.agentKeepAliveTime ??= Date.now() + AGENT_KEEPALIVE_ALARM_MS;
      times.push(this.agentKeepAliveTime);
    }

    // External-message responses: a ready one is delivered as soon as possible, and delivered
    // records are swept once they age out.
    this.#sweepDeliveredExternalMessageResponses();
    let hasReadyExternalMessageResponse = [...this.storage.gadgetResponseDeliveries.readyByIdempotencyKey.list({ limit: 1 })]
      .length > 0;
    if (hasReadyExternalMessageResponse) {
      times.push(Date.now());
    }
    let nextDeliveredRecord = [...this.storage.gadgetResponseDeliveries.deliveredByDeliveredAt.list({ limit: 1 })][0];
    if (nextDeliveredRecord?.status === "delivered") {
      times.push(nextDeliveredRecord.deliveredAt + AGENT_RESPONSE_DELIVERED_RETENTION_MS);
    }

    let next = times.length > 0 ? Math.max(notBefore, Math.min(...times)) : null;
    if (next === this.scheduledAlarm) return;
    this.scheduledAlarm = next;
    if (next === null) this.ctx.storage.deleteAlarm();
    else this.ctx.storage.setAlarm(next);
  }

  protected deleteExternalMessageResponseDeliveryRecord(record: ExternalMessageRecord): void {
    this.storage.gadgetResponseDeliveries.delete(record.idempotencyKey);
    if (record.status !== "delivered") {
      record.chatGatewayRpcTarget[Symbol.dispose]();
    }
  }

  #sweepDeliveredExternalMessageResponses(): void {
    let cutoff = Date.now() - AGENT_RESPONSE_DELIVERED_RETENTION_MS;
    this.ctx.storage.transactionSync(() => {
      for (let record of Array.from(this.storage.gadgetResponseDeliveries.deliveredByDeliveredAt.list({ end: cutoff }))) {
        this.storage.gadgetResponseDeliveries.delete(record.idempotencyKey);
      }
    });
  }

  /**
   * Resolves once no agents are running and no drain is mid-flight -- a drain hands a finished
   * turn's work to the next, so waiting through it is what keeps "all agents complete" true at
   * the moment this returns. Used by `alarm()` to hold the DO open through whole turn chains.
   */
  async waitForAllAgentsToComplete(): Promise<void> {
    // Teardown can synchronously hand off to a resumed execution before these waiters run. A
    // drain in flight is that handoff mid-flight -- it starts the next turn after its first
    // await -- so waiting on it too keeps this wait from resolving between a turn's end and the
    // turn it hands off to (runAlarmTasks' pass loop checks the same two conditions).
    while (this.runningAgents.size > 0 || this.pendingCallDrains.size > 0) {
      let {promise, resolve} = Promise.withResolvers<void>();
      this.#allAgentsIdleWaiters.push(resolve);
      await promise;
    }
  }

  /**
   * Allocate a workpiece ID from the shared counter. (The counter is named `nextGatekeeperId`
   * for historical reasons; see makeOverseerStorage.)
   */
  allocateWorkpieceId(): WorkpieceId {
    let id = this.storage.nextGatekeeperId.get();
    this.storage.nextGatekeeperId.put(id + 1);
    return id;
  }

  /**
   * Resolve an optional gadget reference: absent means the workspace's default gadget. Throws if
   * absent and the workspace has no default gadget.
   */
  resolveGadgetId(gadgetId?: WorkpieceId): WorkpieceId {
    if (gadgetId !== undefined) return gadgetId;
    let def = this.defaultGadgetId;
    if (def === undefined) {
      throw new Error("This workspace has no default gadget; a gadget must be named explicitly.");
    }
    return def;
  }

  /**
   * Get a gadget's registry record, throwing an explicit error if it doesn't exist. A reference
   * to a deleted default gadget gets a distinct message, since old records resolving through
   * `defaultGadgetId` land here rather than silently retargeting some other gadget.
   */
  getGadgetRecord(id: WorkpieceId): GadgetRecord {
    let record = this.storage.gadgets.get(id);
    if (!record) {
      if (this.defaultGadgetId === id) {
        throw new Error("This workspace's original gadget has been deleted.");
      }
      throw new Error(`No such gadget: ${id}`);
    }
    if (record.type !== "gadget") {
      // Every gadget-only path funnels through here, so this one check is what keeps a worktree
      // id out of gadget operations (facets, bindings, blueprints, ...).
      throw new Error(`Workpiece ${id} is a worktree, not a gadget.`);
    }
    return record;
  }

  /** Get a worktree's registry record, throwing an agent-readable error otherwise. */
  getWorktreeRecord(id: WorkpieceId): WorktreeRecord {
    let record = this.storage.gadgets.get(id);
    if (record?.type !== "worktree") {
      throw new Error(`No such worktree: ${id}`);
    }
    return record;
  }

  /** Whether the id names a live worktree record (a deleted workpiece is not a worktree here). */
  isWorktree(id: WorkpieceId): boolean {
    return this.storage.gadgets.get(id)?.type === "worktree";
  }

  /**
   * Facet name for the given gadget. The facet name is a storage key, so the default gadget
   * keeps the legacy name "gadget"; all others get `gadget${id}` (collision-free with
   * `gatekeeper${id}` thanks to the shared workpiece counter).
   */
  gadgetFacetName(id: WorkpieceId): string {
    return this.defaultGadgetId === id ? "gadget" : `gadget${id}`;
  }

  /**
   * Resolve an agent tool's optional workpiece reference. Absent means the workspace's default
   * gadget; the error when there is none tells the agent how to proceed. When `mustExist` is
   * set, the workpiece must currently exist in the registry (used by live file tools; history
   * replay omits it so old edits to since-deleted gadgets still resolve) and, if `forChatId` is
   * also given, must be visible to that chat -- a gadget still provisional to some *other* chat
   * is treated as nonexistent (its files exist only in its own chat's proposed changes), and so
   * is any other chat's worktree (worktrees are chat-private for life).
   */
  resolveWorkpieceRoot(workpieceId?: WorkpieceId, mustExist?: boolean, forChatId?: number)
      : {workpieceId: WorkpieceId} {
    if (workpieceId === undefined && this.defaultGadgetId === undefined) {
      throw new Error(
          "No workpiece was specified, and this workspace has no default gadget. Pass the " +
          "`workpiece` parameter naming the gadget to operate on, or create one with " +
          "createGadget first.");
    }
    let id = this.resolveGadgetId(workpieceId);
    if (mustExist) {
      let record = this.storage.gadgets.get(id);
      if (!record && this.storage.gatekeepers.get(id)) {
        // A name resolving here almost certainly came from the chat binding map, so tell the
        // agent what's wrong in binding terms rather than "no such gadget: <number>".
        throw new Error("That binding refers to an external resource, not a gadget.");
      }
      if (!record) this.getGadgetRecord(id);  // throws the explicit not-found error
      if (record?.type === "worktree") {
        if (record.chatId !== forChatId) {
          throw new Error(`No such gadget: ${id}`);
        }
      } else if (record?.pending && forChatId !== undefined &&
                 record.pending.chatId !== forChatId) {
        throw new Error(`No such gadget: ${id}`);
      }
    }
    return {workpieceId: id};
  }

  /**
   * Create a new gadget workpiece with the given title and binding name, no files, and no
   * bindings. The title is trimmed and must be non-empty (there are no default gadget titles;
   * every creation path names its gadget). The binding name must be valid (see
   * validateBindingName) and unique among the workspace's gadgets -- including pending ones,
   * whose records are real and so reserve their name from creation. If `chatId` is given, the
   * gadget is provisional to that chat (see GadgetRecord.pending); the caller is responsible for
   * getting its creation recorded in the chat log so the pending record gets sequence-stamped
   * (see addChatMessages()). Otherwise the gadget is permanent and `initialCommitId` -- its
   * empty-tree initial commit, written by the caller beforehand -- is required: every permanent
   * gadget is born with a head (see GadgetRecord.commitId). `blueprint` is the blueprint being
   * instantiated, if any, and `output` the format it declares. A gadget created from none is
   * recorded as made from scratch (see GadgetRecord.upstream); one created from a blueprint
   * comes to follow it when its creation is accepted. `actorUserId` (hex user DO ID) feeds
   * analytics only; a permanent creation's caller records its own workpiece_created, naming its
   * source.
   */
  createGadget(title: string, bindingName: string, chatId?: number,
               blueprint?: {output?: BlueprintOutput}, initialCommitId?: string,
               actorUserId?: string): GadgetRecord {
    title = title.trim();
    if (!title) {
      throw new Error("A gadget requires a non-empty title.");
    }
    validateBindingName(bindingName);
    // Pre-check the unique index for a friendly error (the index would throw on put() anyway,
    // but with an internal message; storage writes are synchronous, so this isn't racy).
    let conflict = this.storage.gadgets.byBindingName.get(bindingName);
    if (conflict) {
      if (conflict.pending && conflict.pending.chatId !== chatId) {
        throw new Error(`The gadget name "${bindingName}" is claimed by a gadget still pending ` +
            `in another chat. Accept or revert that chat's changes first, or choose a different ` +
            `name.`);
      }
      throw new Error(`There is already a gadget named "${bindingName}".`);
    }
    let record: GadgetRecord = {
      type: "gadget",
      id: this.allocateWorkpieceId(),
      title,
      created: new Date(),
      bindingName,
      bindings: {},
    };
    if (blueprint?.output) {
      record.output = blueprint.output;
    }
    if (!blueprint) {
      record.upstream = {};
    }
    if (chatId !== undefined) {
      record.pending = {chatId};
    } else {
      if (initialCommitId === undefined) {
        throw new Error("A permanent gadget must be created with its initial commit.");
      }
      record.commitId = initialCommitId;
    }
    this.storage.gadgets.put(record);
    if (chatId !== undefined) {
      this.recordGadgetAnalytics({
        event_name: "workpiece_proposed",
        // The agent's createGadget tool creates inside a turn, whose initiator is the creator.
        user_id: actorUserId ?? this.storage.activeAgents.get(chatId)?.initiatorUserId,
        workpiece_id: record.id,
      });
    }
    return record;
  }

  /**
   * Create a new worktree workpiece rooted at the given commit id, provisional to (and permanently
   * private to) the given chat. The id is resolved -- and the commit pulled, if only a gatekeeper
   * has it -- by WorkspaceGitCache.fetchCommit. Like createGadget, the
   * caller (the agent's createWorktree tool) is responsible for getting the creation recorded in
   * the chat log -- `createdWorktrees` on the step's "changes" message -- which makes the pending
   * record permanent. The worktree is not pinned in the chat by its creation: it reads as its
   * accepted commit (`pinBase`) until the first modification pins it (see commitAgentStep).
   */
  async createWorktree(title: string, chatId: number, commitId: string)
      : Promise<{id: WorkpieceId, title: string, baseCommit: string}> {
    title = title.trim();
    if (!title) {
      throw new Error("A worktree requires a non-empty title.");
    }
    let baseCommit = await this.gitCache.fetchCommit(commitId);

    // The awaits above could have outlived the chat; a pending record for a deleted chat would
    // never be reaped.
    if (!this.storage.chatMeta.get(chatId)) {
      throw new Error(`No such chat: ${chatId}`);
    }

    // Informational only (pull routing reads the metadata rows directly): the first recorded
    // source, when the commit came from a gatekeeper at all.
    let meta = this.storage.gitObjectMetadata.get(baseCommit);
    let sourceGatekeeperId = meta?.onRemote[0] ?? meta?.pullableFrom[0];

    let record: WorktreeRecord = {
      type: "worktree",
      id: this.allocateWorkpieceId(),
      title,
      created: new Date(),
      chatId,
      ...(sourceGatekeeperId !== undefined ? {sourceGatekeeperId} : {}),
      baseCommit,
      headCommit: baseCommit,
      pinBase: baseCommit,
      pending: {chatId},
    };
    this.storage.gadgets.put(record);
    return {id: record.id, title, baseCommit};
  }

  /** The workpieces (gadgets and worktrees) still provisional to the given chat, in id order. */
  listPendingGadgets(chatId: number): WorkpieceRecord[] {
    return [...this.storage.gadgets.list()].filter(g => g.pending?.chatId === chatId);
  }

  /**
   * Auto-create the workspace's single gadget and record it as the default gadget. New workspaces
   * normally start with zero gadgets and the agent creates gadgets explicitly (never assigning
   * `defaultGadgetId`); the exceptions are blueprint instantiation, which still creates a fresh
   * workspace containing one gadget, and the git-storage migration, which recovers the implicit
   * gadget of a legacy workspace whose only code was chat-proposed (see migrateCodeLogToGit).
   * `commitId` is the gadget's initial commit, written by the caller beforehand: every permanent
   * gadget is born with a head (see GadgetRecord.commitId). Only the migration may omit it -- it
   * synthesizes and assigns the head itself before its blockConcurrencyWhile critical section
   * ends, so nothing can observe the momentarily head-less record.
   * TODO(multi-gadget): Remove the blueprint-instantiation use once blueprint instantiation is
   * reworked (plan phase 5).
   */
  ensureDefaultGadget(commitId: string | undefined): WorkpieceId {
    if (this.defaultGadgetId !== undefined) return this.defaultGadgetId;
    let id = this.allocateWorkpieceId();
    // Set defaultGadgetId first, so that workpiece subscribers never see the gadget without its
    // legacy names (see the `defaultGadgetId` singleton).
    this.storage.defaultGadgetId.put(id);
    this.defaultGadgetId = id;
    this.storage.gadgets.put({
      type: "gadget",
      id,
      title: this.storage.title.get(),
      created: new Date(),
      // This only runs in a fresh workspace with no gadgets, so the name can't conflict.
      bindingName: "GADGET",
      bindings: {},
      ...(commitId !== undefined ? { commitId } : {}),
    });
    return id;
  }

  /**
   * Fallback bookkeeping target for hooks bound from executeCode when we can't tell which gadget
   * the callback stub restores to (see bindHook): the workspace's first gadget, i.e. the default
   * gadget when it exists, else the lowest-numbered gadget (including a provisional one — hooks
   * recorded against it are torn down by removeWorkpiece() if the provisional gadget is later
   * rejected), else undefined.
   */
  executeCodeRestoreTarget(): WorkpieceId | undefined {
    let def = this.defaultGadgetId;
    if (def !== undefined && this.storage.gadgets.get(def)?.type === "gadget") return def;
    for (let gadget of this.storage.gadgets.list()) {
      if (gadget.type === "gadget") return gadget.id;
    }
    return undefined;
  }

  /**
   * The binding edges visible to the given chat, of a gadget or an agent spawner: an edge still
   * provisional to some *other* chat belongs to that chat's proposed changes and is treated as
   * nonexistent here. With `forChatId` undefined, only permanent (non-pending) edges are visible
   * (mainline loads, spawns, blueprints, sharing, the Connections UI).
   */
  visibleBindings(holder: {bindings: Record<string, BindingRecord>}, forChatId?: number)
      : [string, BindingRecord][] {
    return Object.entries(holder.bindings).filter(
        ([, edge]) => !edge.pending || edge.pending.chatId === forChatId);
  }

  /**
   * Subscribe to the workspace's workpiece list: gadgets, and -- on subscriptions that include
   * pending workpieces -- worktrees. When `includePending` is false (non-owner/use-role
   * subscribers), gadgets still provisional to some chat are withheld entirely, and so is every
   * worktree, accepted or not: both are proposals within the owner's chats, not part of the
   * shared workspace (a worktree is its chat's for life). (A gadget's promotion then surfaces it
   * via the collection's update notification.) Those subscribers are not told which blueprint a
   * gadget follows either: its id is a share link to code they have no other way to read. Every
   * record write re-delivers the summary, which is how a worktree's `pinBase` (advanced by an
   * accept) and `headCommit` (an explicit commit, or its rollback) reach clients.
   */
  subscribeToWorkpieces(subscriber: RpcStub<WorkpiecesSubscriber>,
                        includePending: boolean): RpcStub<{}> {
    let gadgets = this.storage.gadgets;
    subscriber = subscriber.dup();  // keep stub after return

    let toSummary = (record: WorkpieceRecord): WorkpieceSummary => {
      if (record.type === "worktree") {
        return {
          id: record.id,
          type: "worktree",
          title: record.title,
          chatId: record.chatId,
          pinBase: record.pinBase,
          headCommit: record.headCommit,
          baseCommit: record.baseCommit,
        };
      }
      let summary: WorkpieceSummary = {
        id: record.id,
        type: "gadget",
        title: record.title,
      };
      if (record.commitId !== undefined) {
        summary.commitId = record.commitId;
      }
      if (record.output) {
        summary.output = record.output;
      }
      if (record.upstream && includePending) {
        summary.upstream = record.upstream;
      }
      if (record.pending) {
        summary.chatId = record.pending.chatId;
      }
      return summary;
    };

    let disposed = false;
    let unsubscribe = () => {
      if (disposed) return;
      disposed = true;
      gadgets.unsubscribe(dbSubscriber);
      subscriber[Symbol.dispose]();
    };

    // Whether the record is published to this subscriber (see above for what is withheld).
    let published = (record: WorkpieceRecord): boolean =>
        includePending || (record.type === "gadget" && !record.pending);

    let dbSubscriber = {
      add(record: WorkpieceRecord) {
        if (published(record)) subscriber.entry(toSummary(record)).catch(unsubscribe);
      },
      update(_oldRecord: WorkpieceRecord, newRecord: WorkpieceRecord) {
        if (published(newRecord)) subscriber.entry(toSummary(newRecord)).catch(unsubscribe);
      },
      remove(record: WorkpieceRecord) {
        if (published(record)) subscriber.removed(record.id).catch(unsubscribe);
      },
    };

    subscriber.onRpcBroken(() => unsubscribe());

    for (let record of gadgets.list()) {
      if (published(record)) subscriber.entry(toSummary(record)).catch(unsubscribe);
    }
    subscriber.ready().catch(unsubscribe);

    gadgets.subscribe(dbSubscriber);

    // @ts-expect-error Bugs in native RPC types make this not work currently.
    return new NativeRpcStub<{}>({
      [Symbol.dispose]() {
        unsubscribe();
      }
    });
  }

  // =======================================================================================

  recordGadgetAnalytics(event: ProductAnalyticsGadgetInput): void {
    recordAnalytics(this.ctx, this.env, {
      ...event,
      gadget_id: this.ctx.id.toString(),
      gadget_owner_user_id: this.ownerId,
    });
  }


  // =======================================================================================
  // Commit-backed chat code.
  //
  // Mainline code is git commits (see git-store.ts); a chat's uncommitted changes are one
  // revisioned stream of code changes -- `chatChanges` rows composed on top of pinned commits (see
  // ChatCodeBase in the API and `@gadgets/workshop-shared/code-change`). A gadget joins the stream
  // only when its code is first modified in the chat, pinned at the commit its changes compose on
  // top of, while unpinned gadgets track mainline head live. Accepting changes ends the chat's
  // epoch: the pin set resets and the change stream restarts under a new generation.

  /**
   * The chat's code base with the absent record defaulted (see ChatCodeBase: both sides of the
   * wire read an absent record as exactly this). Returns a fresh object when defaulting, so
   * callers may mutate the result and write it back.
   */
  chatCodeBase(meta: AiChatMetadata): ChatCodeBase {
    return meta.codeBase ?? {pins: [], generation: 0, revision: 0};
  }

  /**
   * AgentHooks implementation: the gadget's current head commit, or undefined if it has none
   * (still pending, created outside chats and never accepted, or deleted). Worktrees have no
   * mainline head -- their `headCommit` is a different notion -- so this reports undefined for
   * them; getWorktreePinBase is their counterpart.
   */
  getGadgetHead(gadgetId: WorkpieceId): string | undefined {
    let record = this.storage.gadgets.get(gadgetId);
    return record?.type === "gadget" ? record.commitId : undefined;
  }

  /**
   * AgentHooks implementation: a worktree's accepted commit (see WorktreeRecord.pinBase) -- what
   * an unpinned worktree reads at and what its first modification pins at, the worktree analog
   * of getGadgetHead -- or undefined for anything that isn't a live worktree.
   */
  getWorktreePinBase(id: WorkpieceId): string | undefined {
    let record = this.storage.gadgets.get(id);
    return record?.type === "worktree" ? record.pinBase : undefined;
  }

  /** AgentHooks implementation: read a commit's file map (see GitStore.readCommitFiles). */
  readCommitFiles(oid: string): Promise<Map<string, string>> {
    return this.gitStore.readCommitFiles(oid);
  }

  /**
   * AgentHooks implementation, and the read behind Overseer.listChangedPaths: the paths whose
   * entry differs between two commits' trees (see WorkspaceGitCache.changedFilePathsBetween),
   * sorted.
   */
  async listChangedPaths(fromCommit: string, toCommit: string): Promise<string[]> {
    return [...await this.gitCache.changedFilePathsBetween(fromCommit, toCommit)].toSorted();
  }

  /**
   * AgentHooks implementation: lazily read one file of a commit's tree (see
   * WorkspaceGitCache.readFileAtCommitIfExists) -- the base resolver behind worktree reads and
   * the way unpinned gadget reads are served too.
   */
  readFileAtCommit(commit: string, path: string): Promise<string | undefined> {
    return this.gitCache.readFileAtCommitIfExists(commit, path);
  }

  /** AgentHooks implementation: the same read, plus the blob's oid for the read's stamp. */
  readFileAtCommitWithOid(commit: string, path: string)
      : Promise<{text: string, oid: string} | undefined> {
    return this.gitCache.readFileAtCommitWithOid(commit, path);
  }

  /**
   * AgentHooks implementation: a regular file's blob oid by path (see
   * WorkspaceGitCache.fileOidAtCommit), for the agent's read-freshness comparisons.
   */
  fileOidAtCommit(commit: string, path: string): Promise<string | undefined> {
    return this.gitCache.fileOidAtCommit(commit, path);
  }

  /**
   * AgentHooks implementation: a blob by oid as text (see WorkspaceGitCache.readTextBlob). A
   * stamped read's blob was pulled by the read itself, so this is a local read.
   */
  readBlobText(oid: string, path: string): Promise<string> {
    return this.gitCache.readTextBlob(oid, undefined, path);
  }

  /**
   * AgentHooks implementation: the write side of the tree-entry modes rules (see
   * WorkspaceGitCache.assertWorktreePathWritable).
   */
  assertWorktreePathWritable(commit: string, path: string): Promise<void> {
    return this.gitCache.assertWorktreePathWritable(commit, path);
  }

  /** AgentHooks implementation: the grep tool's scan (see scanWorkpieceForGrep). */
  grepWorkpiece(turn: WorktreeTurnAccess, workpieceId: WorkpieceId, base: string | undefined,
                path?: string): Promise<GrepScan> {
    return scanWorkpieceForGrep(this.gitCache, turn, workpieceId, base, path);
  }

  /**
   * The lazy half of worktree chat content: for each `edit` in `change` that targets a worktree
   * path the content map does not yet hold, reads the file at the worktree's pinned base commit
   * and seeds it into (a copy of) the content, so the edit applies and validates exactly as if
   * the whole base tree had been materialized. Only edits need bases (a `set` is valid against
   * any state and a `remove` of an absent path is a no-op), so untouched files are never read. A
   * path absent from the base stays absent -- "edit of absent file" is then the change's own
   * validation error -- while unreadable content (oversized/binary/symlink) throws its
   * descriptive error, which ingestion surfaces to the submitter. (One deliberate quirk falls
   * out for hand-rolled clients only: a row that edits a path an earlier row removed re-seeds
   * the base text rather than failing -- every fold applies the same rule in the same order, so
   * all replicas agree; the shipped producers never emit that sequence.)
   */
  async seedWorktreeEditBases(content: CodeContent, change: CodeChange,
                              worktreeBases: Map<WorkpieceId, string>): Promise<CodeContent> {
    let result = content;
    for (let [key, entries] of Object.entries(change)) {
      let worktreeId = Number(key);
      let base = worktreeBases.get(worktreeId);
      if (base === undefined) continue;
      for (let [path, fileChange] of entries) {
        if (!("edit" in fileChange) || result.get(worktreeId)?.has(path)) continue;
        let text = await this.gitCache.readFileAtCommitIfExists(base, path);
        if (text === undefined) continue;
        if (result === content) result = new Map(content);
        let files = new Map(result.get(worktreeId));
        files.set(path, text);
        result.set(worktreeId, files);
      }
    }
    return result;
  }

  /**
   * Cache of the chat's *current* content -- buildChatContent() plus undeclared meta pins' bases
   * plus every live change row -- keyed by the (generation, revision) it reflects. Row appends
   * update it incrementally (see #appendChatChangeRow), so the per-keystroke submitCodeChange path
   * never replays the log; anything that rewrites history (revert, epoch reset, draft discard)
   * bumps the generation or is caught by the revision check, and chat deletion clears it via
   * destroyLiveChat.
   */
  protected chatContentCache = new Map<number, {generation: number, revision: number,
                                       content: CodeContent}>();

  /**
   * Cache summarizing the live (unretired) window -- its summed serialized-size estimate and its
   * row count -- keyed by the (generation, revision) it reflects. submitCodeChange consults both
   * per keystroke (the byte trigger before appending, the row-count trigger after), and
   * recomputing either means re-reading every live row from storage -- O(window) per keystroke,
   * quadratic over an editing session. Row appends update the entry incrementally (see
   * #appendChatChangeRow) and retirement drops it (see #retireChatChanges); anything else that
   * changes the window (revert, epoch reset, draft discard) bumps the generation or revision,
   * which invalidates the entry. A miss (also after a DO restart) recomputes with one full
   * listing (see #liveWindowSummary).
   */
  protected liveWindowCache = new Map<number, {generation: number, revision: number, bytes: number,
                                      count: number}>();

  /**
   * The async half of getCurrentChatContent's live-row worktree seeding: like
   * seedWorktreeEditBases, but additionally records every looked-up base into `seeds`
   * (`${worktreeId}:${path}` -> text, or null for a path absent from the base), so the
   * synchronous tail can re-seed without awaiting.
   */
  protected async prefetchWorktreeSeeds(content: CodeContent, change: CodeChange,
                               worktreeBases: Map<WorkpieceId, string>,
                               seeds: Map<string, FileContent | null>): Promise<CodeContent> {
    let result = content;
    for (let [key, entries] of Object.entries(change)) {
      let worktreeId = Number(key);
      let base = worktreeBases.get(worktreeId);
      if (base === undefined) continue;
      for (let [path, fileChange] of entries) {
        if (!("edit" in fileChange) || result.get(worktreeId)?.has(path)) continue;
        let key = `${worktreeId}:${path}`;
        let text = seeds.get(key);
        if (text === undefined) {
          text = await this.gitCache.readFileAtCommitIfExists(base, path) ?? null;
          seeds.set(key, text);
        }
        if (text === null) continue;
        if (result === content) result = new Map(content);
        let files = new Map(result.get(worktreeId));
        files.set(path, text);
        result.set(worktreeId, files);
      }
    }
    return result;
  }

  /**
   * The synchronous half: seeds a change's worktree edit bases from the prefetched map, or
   * returns null when a needed base wasn't prefetched (the row landed mid-prefetch; the caller
   * retries the whole read).
   */
  protected applyPrefetchedWorktreeSeeds(content: CodeContent, change: CodeChange,
                                worktreeBases: Map<WorkpieceId, string>,
                                seeds: Map<string, FileContent | null>): CodeContent | null {
    let result = content;
    for (let [key, entries] of Object.entries(change)) {
      let worktreeId = Number(key);
      if (!worktreeBases.has(worktreeId)) continue;
      for (let [path, fileChange] of entries) {
        if (!("edit" in fileChange) || result.get(worktreeId)?.has(path)) continue;
        let text = seeds.get(`${worktreeId}:${path}`);
        if (text === undefined) return null;
        if (text === null) continue;  // absent from the base: the edit's own validation reports
        if (result === content) result = new Map(content);
        let files = new Map(result.get(worktreeId));
        files.set(path, text);
        result.set(worktreeId, files);
      }
    }
    return result;
  }

  /** Broadcast one accepted row to chat subscribers (see AiChatSubscriber.changeApplied). */
  emitChatChangeApplied(row: ChatChangeRecord): void {
    for (let subscriber of this.#chatSubscribers) {
      subscriber.changeApplied(row.chatId, row.generation, row.revision, row.author, row.change,
                               row.submission).catch(() => {
        subscriber[Symbol.dispose]();
        this.#chatSubscribers.delete(subscriber);
      });
    }
  }

  /**
   * Mark the given rows retired (materialized, or their generation closed): excluded from
   * content folds and subscribe-replay, retained briefly as the transform window (see
   * ChatChangeRecord.retired).
   */
  protected retireChatChanges(rows: ChatChangeRecord[]): void {
    for (let row of rows) {
      row.retired = true;
      this.storage.chatChanges.put(row);
    }
    // Retirement always covers the generation's entire live window (materialization and epoch
    // close both list-then-retire), so the window summary no longer describes it; drop the entry
    // and let the next read recompute -- over a window that is empty at that point.
    if (rows.length > 0) {
      this.liveWindowCache.delete(rows[0].chatId);
    }
  }

  /**
   * Lazily expire retired rows past the retention horizon, and drop retired generations that
   * are no longer bridgeable at all.
   */
  protected pruneRetiredChatChanges(chatId: number): void {
    let cutoff = Date.now() - CHAT_CHANGE_RETIRED_TTL_MS;
    for (let row of Array.from(this.storage.chatChanges.list({prefix: chatKeyPrefix(chatId)}))) {
      if (row.retired && row.timestamp.getTime() < cutoff) {
        this.storage.chatChanges.deleteRecord(row);
      }
    }
  }

  /**
   * Which chat ID is each gadget's facet currently running from? Keyed by gadget ID; a gadget
   * with no entry has never had its facet loaded this session.
   */
  protected runningChatIds = new Map<WorkpieceId, number | null>();

  /**
   * The worktree turn state registered by a running executeCode, keyed by chat (one turn per
   * chat, and executeCode calls within it are sequential). `executionId` names the registering
   * execution: worktree loopbacks are minted with it and verified against it, so only stubs from
   * the currently-running execution resolve. See executeCodeMode.
   */
  protected activeWorktreeTurns = new Map<number,
      {access: WorktreeTurnAccess, initiator: AiChatAuthorInfo, executionId: string}>();

  protected attachmentWorkspaceFilename(
      attachment: ChatAttachmentRef, used: Set<string>): string {
    let supplied = attachment.name?.replaceAll("\\", "/").split("/").at(-1);
    let fallbackExtension = CHAT_ATTACHMENT_EXTENSION_BY_MIME.get(attachment.mimeType) ?? ".bin";
    let filename = (supplied || `attachment-${attachment.id.slice(0, 8)}${fallbackExtension}`)
        // eslint-disable-next-line no-control-regex -- Uploaded filenames must exclude ASCII control characters.
        .replace(/[\u0000-\u001f\u007f]/g, "_").trim();
    if (!filename || filename === "." || filename === ".." || filename.toLowerCase() === ".git") {
      filename = `attachment-${attachment.id.slice(0, 8)}${fallbackExtension}`;
    }
    // Git encodes paths as UTF-8. Keep both the recorded path and the Linux filename valid,
    // leaving room below NAME_MAX for collision suffixes.
    let prefix = "", bytes = 0;
    const encoder = new TextEncoder();
    for (const character of filename.toWellFormed()) {
      bytes += encoder.encode(character).byteLength;
      if (bytes > 200) break;
      prefix += character;
    }
    filename = prefix;

    let dot = filename.lastIndexOf(".");
    let stem = dot > 0 ? filename.slice(0, dot) : filename;
    let extension = dot > 0 ? filename.slice(dot) : "";
    let candidate = filename;
    for (let suffix = 2; used.has(candidate); suffix++) {
      candidate = `${stem}-${suffix}${extension}`;
    }
    used.add(candidate);
    return candidate;
  }

  /**
   * Connections whose scope widening scheduled a restart, blocked until the reset lands. The
   * widening site persists its change before the reset (addGatekeeper's record, bindWorkpiece's
   * edge, mergeChatChanges' promotion, enableHookRecord's flip), but the sessions that were never
   * verified against the connection stay live for the reset's ~100ms response-delivery delay --
   * and nothing else stops them reaching it in that window (ids are sequential, so a live build
   * session can even guess a brand-new one; a "use" session's gadget reload mints fresh binding
   * loopbacks). Every client-reachable route to the connection checks this set
   * (assertGatekeeperUsable/gatekeeperUsable). In-memory and never cleared: the scheduled reset
   * is what clears it, by destroying this object. Only ever populated when a restart really was
   * scheduled -- marking without one would brick the connection until some unrelated restart came
   * along.
   */
  protected gatekeepersPendingRestart = new Set<number>();

  /**
   * Validate client-supplied capsules before they are persisted: each must reference an existing
   * workpiece, and never a gadget still provisional to another chat (a pending gadget belongs to
   * that chat's unaccepted proposal, not (yet) to the workspace). Enforcing this at the single
   * commit chokepoint means everything downstream of the chat log (binding-name stamping, env
   * build, describeBinding) can trust persisted capsule targets, though targets may of course be
   * deleted later.
   */
  protected validateCapsules(chatId: number, capsules: CapsuleSpecifier[] | undefined): void {
    for (let capsule of capsules ?? []) {
      let gadget = this.storage.gadgets.get(capsule.gatekeeperId);
      if (gadget) {
        if (gadget.type === "worktree") {
          // Worktrees are chat-private agent workpieces; nothing produces capsules for them.
          throw new Error(`Chat message references workpiece ${capsule.gatekeeperId}, which is ` +
              `a worktree and cannot be pasted.`);
        }
        if (gadget.pending && gadget.pending.chatId !== chatId) {
          throw new Error(`Chat message references gadget ${capsule.gatekeeperId}, which is ` +
              `still pending in another chat.`);
        }
      } else if (!this.storage.gatekeepers.get(capsule.gatekeeperId)) {
        throw new Error(`Chat message references workpiece ${capsule.gatekeeperId}, which does ` +
            `not exist.`);
      }
    }
  }

  protected async deliverExternalMessageResponseToTarget(record: ExternalMessageRecord): Promise<void> {
    if (record.status !== "ready") return;

    try {
      await record.chatGatewayRpcTarget.onGadgetResponse({
        text: record.responseText,
      });
    } catch (err) {
      this.logger.error("failed to deliver external message response", {
        event: "external.message.response.delivery.failed",
        chatId: record.chatId,
        error: err,
      });
      throw err;
    }
    this.storage.gadgetResponseDeliveries.put({
      idempotencyKey: record.idempotencyKey,
      chatId: record.chatId,
      promptSequence: record.promptSequence,
      status: "delivered",
      createdAt: record.createdAt,
      deliveredAt: Date.now(),
    });
    record.chatGatewayRpcTarget[Symbol.dispose]();
  }

  /**
   * The log is the wait record. A nudge is the consumption boundary for a previous decision,
   * just as a prompt/callback or built-in /compact is the boundary for a new turn. Check connections
   * AND actions together: accepting one kind must not bypass an unanswered request of the other kind.
   */
  protected decisionWait(chatId: number) {
    let actionIds: number[] = [];
    let requestIds: string[] = [];
    let titles: string[] = [];
    let pending = false;
    let denied = false;
    let steered = false;
    let agent: AiChatAuthorInfo | undefined;
    for (let msg of this.storage.chats.list({prefix: chatKeyPrefix(chatId), reverse: true})) {
      if (msg.type === "agentCallback" || msg.type === "agentNudge" ||
          (msg.type === "slashCommand" && msg.request.id.builtin === true &&
           msg.request.id.commandId === "compact") ||
          isTurnPrompt(msg)) {
        break;
      }
      // Null means a committed final response, not an interrupted segment to run again.
      // It also consumed any earlier inline approvals without suspending. A steer the agent read
      // after that response still needs an answer, so the turn is unfinished, waiting on nothing.
      if (!actionIds.length && !requestIds.length && msg.type === "message" &&
          msg.author.type === "agent" && !msg.toolCalls?.length) return steered ? undefined : null;
      steered ||= msg.type === "message" && msg.steered === true;
      if (msg.author.type === "agent") agent ??= msg.author;
      if (msg.type === "connectionRequest" && msg.author.type === "agent") {
        requestIds.push(msg.requestId);
        pending ||= msg.state === "pending";
        denied ||= msg.state === "denied";
      }
      if (msg.type === "action") {
        let record = this.storage.actions.get(msg.actionId);
        if (record?.type === "action" && record.caller.from === "agent" &&
            record.description.awaitDecision) {
          actionIds.push(record.id);
          titles.push(record.description.title);
          pending ||= record.state === "pending";
          denied ||= record.state === "rejected";
        }
      }
    }
    return agent && (actionIds.length || requestIds.length)
        ? {agent, actionIds, requestIds, titles: titles.toReversed(), pending, denied}
        : undefined;
  }

  protected static readonly VENDORS_CACHE_TTL_MS = 60_000;

  emitChatStreamEvent(chatId: number, event: AiChatStreamEvent): void {
    for (let subscriber of this.#chatSubscribers) {
      subscriber.stream(chatId, event).catch(() => {
        subscriber[Symbol.dispose]();
        this.#chatSubscribers.delete(subscriber);
      });
    }
  }

  /**
   * Gadgets that had persistent restore stubs forged during each chat's currently-running
   * executeCode invocation. Used only for bindHook()'s best-effort bookkeeping (see there);
   * cleared when the invocation finishes. A forged stub can't outlive its execution without
   * being bound, and executions within a chat are serialized, so execution scope suffices.
   */
  protected forgedRestoreTargets = new Map<number, Set<WorkpieceId>>();
  /**
   * The fully-constructed runtime object. Intermediate chain classes pass `this.self()`
   * where a helper is typed on the final OverseerImpl class; at runtime this IS that object.
   */
  protected abstract self(): OverseerImpl;
}
