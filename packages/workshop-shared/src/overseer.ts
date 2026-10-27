// The Overseer interface, decomposed into the mixins that compose it: workspace lifecycle
// and metadata, committed code, gatekeepers, actions and hooks, chats, blueprints, and
// collaboration. Overseer itself is the composition -- the wire surface is unchanged.
// Re-exported from api.ts, the single import surface of the API.


import type { WorkpieceId } from "./api.js";
import type { BlueprintGadgetSummary, BlueprintScreenshotUpload } from "./blueprints.js";
import type { BotSelection } from "./bots.js";
import type { AiChatAuthorInfo, AiChatMessage, CapsuleSpecifier, ChatAttachmentHandle, MessageFormatRef, SlashCommandChoice, SlashCommandRequest } from "./chat.js";
import type { ActionHistoryFilter, ActionHistoryPage, ActionsSubscriber, AiChatHistoryPage, AiChatMetadata, AiChatSubscriber, CodeChangeSubmission, ConsoleLogSubscriber, MergeChangesResult } from "./chats.js";
import type { GadgetClient, GatekeeperClient } from "./clients.js";
import type { ActionKind, GitOid } from "./gatekeeper.js";
import type { AffectedCollaborator, CollaboratorInfo, CollaboratorRole, ObserverBindingNeed, PresenceSubscriber, ShareLinkInfo } from "./sharing.js";
import type { PreApprovableAction, WorkpiecesSubscriber } from "./workpieces.js";
import type { AgentSpawnerConfig, BoundHookInfo, CreationApproval, FileAtCommit, GadgetMetadata, TreeNode } from "./workspace.js";
import type { RpcStub, RpcTarget } from "capnweb";
/**
 * Interface to a workspace's Overseer, used to display the Gadget Workshop shell UI around that
 * workspace. Workspace-level concerns live here: the gadget registry, committed code (git
 * commits in the workspace's shared object store, each gadget's head recorded in
 * WorkpieceSummary.commitId), per-chat uncommitted changes (a revisioned stream of code changes per
 * chat, applied on top of commits; see ChatCodeBase), chats, actions/hooks, sharing, and
 * blueprint listing. Per-gadget operations live on the GadgetClient sub-capability (see
 * createGadget()/getGadget()).
 */
export interface Overseer extends RpcTarget,
    OverseerWorkspace, OverseerCode, OverseerGatekeepers, OverseerActions, OverseerChats,
    OverseerBlueprints, OverseerCollaboration {
}

/** Workspace lifecycle and metadata: the title, presence and workpiece streams, gadget creation and retrieval, and the workspace's own deletion. */
export interface OverseerWorkspace {

  /** Get metadata describing this workspace. */
  getMetadata(): Promise<GadgetMetadata>;

  /**
   * Get metadata describing this workspace and subscribe to changes.
   *
   * `callback` will be called once immediately with the current metadata, then again any time it
   * changes.
   *
   * Disposing the returned `RpcStub` will cancel the subscription.
   */
  subscribeToMetadata(
      callback: RpcStub<(metadata: GadgetMetadata) => void>)
      : Promise<RpcStub<{}>>;

  /**
   * Receive the current viewer roster, then incremental updates as viewers come and go.
   * A viewer is present for the lifetime of the openGadget() session.
   */
  subscribeToPresence(subscriber: RpcStub<PresenceSubscriber>): Promise<RpcStub<{}>>;

  /** Change the workspace title. */
  setTitle(title: string): Promise<void>;

  /**
   * Instruct the workspace to delete itself, removing it from the User's workspace list and
   * deleting all data. Further method calls will fail.
   *
   * TODO: Implement undelete, maybe using PITR...
   */
  deleteSelf(): Promise<void>;

  /**
   * Subscribe to the workspace's workpiece list.
   *
   * The subscriber receives one entry() per existing workpiece, followed by ready(), then
   * incremental entry()/removed() calls as workpieces are created, renamed, or deleted, and
   * whenever a summary field changes (a gadget's head, a worktree's accepted or head commit).
   * Gadgets and worktrees are delivered (see WorkpieceSummary for which subscriptions see
   * worktrees).
   *
   * Disposing the returned `RpcStub` will cancel the subscription.
   */
  subscribeToWorkpieces(subscriber: RpcStub<WorkpiecesSubscriber>): Promise<RpcStub<{}>>;

  /**
   * Create a new gadget workpiece in this workspace. `title` is required -- gadgets have no
   * default title. The new gadget starts with no files and no bindings.
   *
   * If `chatId` is provided, the creation is provisional to that chat, exactly like code edits
   * made with a chat open: a `changes` message records it in the chat log (see
   * `createdGadgets`), and the gadget remains pending (see WorkpieceSummary.chatId) until
   * the user accepts the chat's changes through that message (merging deletes the pending marker;
   * reverting deletes the gadget). Without `chatId` the gadget is created permanently, with an
   * empty initial commit as its head (see WorkpieceSummary.commitId).
   *
   * `bindingName` is the name under which the gadget appears in chat envs and the workspace
   * default binding list (see validateBindingName()). When absent, the server chooses one from
   * the title (via the quick model when configured, else a generic fallback). Gadget binding
   * names are unique within the workspace: throws if the name is already taken by another
   * gadget -- including one still pending in another chat (retry after that chat's changes are
   * accepted or reverted).
   */
  createGadget(title: string, chatId?: number, bindingName?: string)
      : Promise<RpcStub<GadgetClient>>;

  /**
   * Get the gadget with the given workpiece ID. To allow for pipelining, this throws an
   * exception if there is no such gadget.
   */
  getGadget(id: WorkpieceId): Promise<RpcStub<GadgetClient>>;
}

/** The committed-code read surface and a chat's code edits: git-tree reads at any commit and the single submission path for uncommitted changes. */
export interface OverseerCode {

  /**
   * Read a commit's whole tree as nested TreeNodes: the root directory's entries, each
   * directory carrying its own, in git tree order (byte order of names, a directory sorting as
   * if its name had a trailing `/`). Only tree objects are read -- never blobs -- so the
   * response is proportional to the commit's entry count. Commits are immutable, so responses
   * are cacheable client-side by commit ID. Like readFilesAtCommit(), the read may pull missing
   * trees through the gatekeeper that provided the commit.
   *
   * Together with readFilesAtCommit() this is how clients read committed code: a workpiece's
   * tree at its head or accepted commit (outside any chat, or when the open chat has no pin for
   * it), and the base content of a chat's pins (see ChatCodeBase), one file at a time as it is
   * opened or edited.
   */
  listTree(commitId: string): Promise<TreeNode[]>;

  /**
   * Read the content of the named files at a commit. Returns one `[path, FileAtCommit]` entry
   * per requested path, in request order (a list of pairs rather than a path-keyed object so
   * that file names like `__proto__`, which RPC deserialization drops from object keys, survive
   * in transit -- see CodeChange in `@gadgets/workshop-shared/code-change`). Blobs missing from
   * the workspace's git store are pulled in one batch through the gatekeeper that provided the
   * commit; a pull failure fails the whole call, since it is transient or actionable rather than
   * a fact about any one file, whereas per-file conditions -- absent path, symlink, submodule,
   * binary or oversized content -- are reported per entry (see FileAtCommit).
   *
   * At most MAX_READ_FILES_PER_CALL paths per call. The server stops decoding once the
   * accumulated text exceeds READ_FILES_RESPONSE_BUDGET and omits the remaining paths from the
   * result, so a missing entry means "not answered, ask again" -- never "absent", which is
   * always stated explicitly. Responses are cacheable by (commit ID, path).
   */
  readFilesAtCommit(commitId: string, paths: string[])
      : Promise<[path: string, FileAtCommit][]>;

  /**
   * List the paths whose entry differs between two commits' trees: added, removed, or changed
   * in content or mode, sorted by code unit (as `Array.prototype.sort()` sorts). Only files are
   * listed, never a directory: a symlink or submodule is listed as a file is, and a name that is
   * a file in one tree and a directory in the other lists the file and the paths within the
   * directory. The two commits may come in either order; the list is the same.
   *
   * Like listTree(), only tree objects are read, never blobs, and a subtree with the same id
   * in both is not read at all, so the cost is proportional to what differs. The result is
   * immutable and cacheable by the pair of commit IDs.
   *
   * This is how a client finds the files a merge changed: where a chat's pin has a `baseCommit`
   * other than its `mergedCommit` (see ChatGadgetPinState), the files that differ between the
   * two are changed in the chat even where none of the chat's code changes touch them.
   */
  listChangedPaths(fromCommit: string, toCommit: string): Promise<string[]>;

  /**
   * Submit one code change on a chat's branch. This is the only way to edit code: committed code
   * cannot be written directly -- gadget heads only advance when a chat's changes are accepted
   * (see mergeChanges()).
   *
   * `submission.change` is expressed against the chat's content as of
   * `(submission.generation, submission.revision)` -- that is, the submitter has applied every
   * accepted change of that generation's stream up to and including that revision (see
   * ChatCodeBase). The server transforms the change over any changes accepted since, validates it,
   * appends it to the stream, and broadcasts it (AiChatSubscriber.changeApplied()); the returned
   * `(generation, revision)` is where it landed.
   *
   * `submission.pins` must carry one declaration per *permanent* gadget the change touches that is
   * not yet pinned in the chat, each naming the head commit the client's content derives from.
   * The server checks that each declared base is the gadget's current head, or its first parent
   * (tolerating a race with one concurrent merge), and establishes the pin atomically with the
   * change. A declaration identical to the existing pin is accepted idempotently; one naming a
   * different `baseCommit` (a race between two first editors) throws. Exception: a gadget still
   * pending in this chat has no head commit to pin (see WorkpieceSummary.commitId), so its changes
   * carry no declaration and build its content up from nothing (see ChatCodeBase). A worktree
   * declaration is accepted iff its `baseCommit` is the worktree's accepted commit -- the
   * content as of the chat's last accept, the analog of a gadget's head -- exactly, with no
   * parent tolerance (only this chat's accept moves it, and that closes the generation).
   *
   * Retries: `submission.clientId` names the client's editing session and `submission.seq`
   * numbers its submissions from 1. The server remembers each session's last accepted seq and
   * where it landed -- independently of the changes themselves, so recognition survives
   * materialization, epoch resets, and destructive generation bumps -- and answers a retry of
   * that seq with the recorded result instead of applying it twice. A transport failure must
   * therefore be retried with the *same* seq and an identical payload, never renumbered or
   * re-composed (OT, unlike a CRDT, does not tolerate double-application); a same-seq
   * submission whose content differs is a client bug and is rejected. A seq one past the last
   * accepted (or 1 from a new session) is the next change; anything else is rejected -- discard
   * local edits and rebuild under a fresh clientId. Only the last submission is remembered, so
   * keep at most one in flight.
   *
   * While an agent turn is active, the call throws a retryable error: keep the queued change and
   * resubmit after the turn ends. (The UI already locks editing during turns; this backstops
   * races.)
   *
   * A submission still rooted in the *previous* generation, when that generation was closed by
   * a merge (a content-preserving bump; see ChatCodeBase.generation), is transformed across the
   * boundary and lands in the current generation, so typing straight through someone's accept
   * is seamless. Such a submission's pin declarations are ignored (they describe pre-merge
   * heads; the server derives the new pins itself), and it is rejected if it touches a gadget
   * in ChatCodeBase.prior.discontinuousGadgets (the merge visibly changed that gadget's
   * content) or a gadget that has since been re-pinned at a different base.
   *
   * Every other rejection means the client's local state is unusable: a generation ended by a
   * destructive bump (revert, draft discard, turn abort), a revision older than the server's
   * retained transform window, or an invalid change all mean the client must discard its local
   * edits and rebuild from fresh metadata.
   */
  submitCodeChange(chatId: number, submission: CodeChangeSubmission)
      : Promise<{generation: number, revision: number}>;
}

/** Connector workpieces: looking up existing gatekeepers and creating new ones, plus accepting or denying the connection requests they raise. */
export interface OverseerGatekeepers {

  /** Get an existing gatekeeper by workpiece ID. Throws if the ID doesn't exist. */
  getGatekeeperById(id: WorkpieceId): Promise<GatekeeperClient<any>>;

  /**
   * Try to create a new gatekeeper for this URL.
   *
   * `accountId` is the user's connected account to use to access this resource. To determine an
   * appropriate account, use `subscribeConnectedAccounts()` with a `filter` for this URL, then
   * let the user choose one.
   *
   * The new gatekeeper is a workspace-level workpiece; it is not bound into any gadget's `env` by
   * default. Use GadgetClient.bind() / bindWithSuggestedName() to expose it to a gadget.
   */
  newGatekeeper(accountId: number, resourceUrl: string): Promise<GatekeeperClient<any> | null>;

  /**
   * Create a new gatekeeper for an AI model binding. The model can be any returned by
   * `AuthenticatedApi.listModels()`. A language model's gatekeeper provides a
   * `LanguageModelBinding`, a decision model's a `DecisionModelBinding`.
   */
  newAiModelGatekeeper(modelId: string): Promise<GatekeeperClient<any>>;

  /**
   * Create a new gatekeeper for an agent spawner binding. This allows the gadget to
   * programmatically spawn AI agents to complete tasks.
   */
  newAgentSpawnerGatekeeper(config: AgentSpawnerConfig): Promise<GatekeeperClient<any>>;

  /**
   * Accept an agent's pending connection request (a "connectionRequest" chat message). The caller
   * is responsible for having actually created the gatekeeper (via newGatekeeper()) and passes the
   * resulting gatekeeper id. The gatekeeper is surfaced to the agent as a named binding in the
   * chat's env, under the name the agent chose when it made the request (see
   * `connectionRequest.bindingName`). This marks the request accepted, updates the inline card,
   * and resumes the agent so it can use the resource.
   */
  acceptConnectionRequest(requestId: string, result: {gatekeeperId: WorkpieceId}): Promise<void>;

  /**
   * Deny an agent's pending connection request. Updates the inline card. Does NOT resume the agent:
   * the turn stays ended so the user can decide what to tell the agent to do instead.
   */
  denyConnectionRequest(requestId: string): Promise<void>;
}

/** Actions and hooks: the action log, approval of pending actions, per-hook enablement, auto-approval rules, and the action stream. */
export interface OverseerActions {

  /**
   * Fetch one page of action history, newest first by id (creation order). "all" (the default)
   * pages every record and a record type pages that type — pending records included, each at its
   * creation position; `filter: "pending"` pages only the currently-pending records — the query
   * half of the query-for-state/subscribe-for-deltas contract (see subscribeToActions()).
   *
   * Page size is a server constant. Pages are full until the last: absence of `nextBeforeId`
   * means the history is exhausted; otherwise it is the id of the last returned entry, to pass
   * as `beforeId` for the next-older page.
   */
  listActions(options?: {beforeId?: number, filter?: ActionHistoryFilter})
      : Promise<ActionHistoryPage>;

  /**
   * Approve an action that is currently in the "pending" state. The action will be performed on
   * approval. Approving a creation (see ActionLogEntry.creation) requires `creation`: how the
   * approver chose to make it.
   */
  approveAction(id: number, creation?: CreationApproval): Promise<void>;

  /**
   * Reject an action that is in the "pending" state. This notifies the gatekeeper that it will not
   * be approved in the future.
   */
  rejectAction(id: number): Promise<void>;

  /**
   * List information about bound hooks (which could wake up a gadget asynchronously).
   *
   * The list spans the whole workspace; each entry names the gadget it wakes (see
   * BoundHookInfo.gadgetId), so a per-gadget view must filter on that.
   */
  listHooks(): Promise<BoundHookInfo[]>;

  /** Enable the hook with the given ID. Callbacks will begin flowing. */
  enableHook(id: number): Promise<void>;

  /** Disable the hook with the given ID. Callbacks will stop. */
  disableHook(id: number): Promise<void>;

  /** Permanently delete the hook. Implies disabling it. */
  deleteHook(id: number): Promise<void>;

  /**
   * Enable auto-approval of actions carrying the given `actionKind` (the
   * ActionDescription.actionKind) on the gatekeeper identified by `gatekeeperId`. Future actions
   * with that kind's tag whose author marked them `autoApprovable` are then applied automatically
   * without manual approval, and any matching action(s) already pending are applied immediately.
   *
   * Auto-approval rules are workspace-wide per gatekeeper: approving an action kind approves it
   * no matter which gadget invokes it.
   *
   * Once the workspace has read restricted data (`GadgetMetadata.containsRestrictedData`), rules
   * are stored but never fire: every action pends for manual approval.
   */
  setAutoApprovedActionKind(gatekeeperId: WorkpieceId, actionKind: ActionKind): Promise<void>;

  /**
   * Remove the auto-approval rule for `tag` on the given gatekeeper; matching actions then
   * require manual approval again.
   */
  removeAutoApprovedActionKind(gatekeeperId: WorkpieceId, tag: string): Promise<void>;

  /** List the currently-enabled auto-approval rules. */
  listAutoApprovedActionKinds(): Promise<Array<{ gatekeeperId: WorkpieceId; actionKind: ActionKind }>>;

  /**
   * List the auto-approvable action kinds offered by gatekeepers bound in this workspace. Each
   * entry identifies its connection and reports whether a matching auto-approval rule is enabled.
   */
  listPreApprovableActions(): Promise<PreApprovableAction[]>;

  /**
   * Subscribe to action adds/updates. Dispose the returned stub to unsubscribe.
   *
   * The subscription delivers live deltas only — nothing pre-existing is replayed. Query for
   * state, subscribe for deltas: fetch the current pending set via
   * listActions({filter: "pending"}) and resolved history via the other filters. As with
   * subscribeToChat(), initiate the subscribe call before those reads — there is no need to
   * await its return, only to start it first — so nothing can slip between the snapshot the
   * pages reflect and the stream.
   *
   * The `startAfter` parameter is intended to be used when resubscribing after a disconnect:
   * specify the time of the last action seen, in order to ensure no actions were missed during
   * the disconnect. The bound is inclusive -- records last changed at exactly that time are
   * re-delivered (entries are upserts) -- and the replay arrives in change-time order, not
   * creation order. If not specified, the subscription starts from the current time.
   *
   * Do NOT use `startAfter` as a way to enumerate historical data. Use `listActions()` instead.
   * To ensure no holes between a subscription and historical data, call `subscribeToActions()`
   * immediately before `listActions()`, similar to `subscribeToChat()`.
   */
  subscribeToActions(subscriber: RpcStub<ActionsSubscriber>, startAfter?: Date): Promise<RpcStub<{}>>;
}

/** Chats: threads, messages, history and subscriptions, slash commands and attachments, plus the accept/revert/update lifecycle of a chat's code changes and agent control. */
export interface OverseerChats {

  /** List past AI chats. */
  listChats(): Promise<AiChatMetadata[]>;

  /**
   * List available language models; decision models are left out. The first listed model should
   * be the default, unless the user has chosen something else.
   */
  listModels(): Promise<AiChatAuthorInfo[]>;

  /**
   * Fetch one page of messages in the chat history for the given chat thread. If `beforeSequence`
   * is absent, fetch the current tail. Otherwise, fetch messages before that sequence.
   *
   * Note that if you plan to subscribe to updates, you should initiate the subscription first,
   * before fetching history. Otherwise, you could theoretically miss a message that is sent
   * between when you fetch the history and when you subscribe.
   *
   * In typical usage, the client subscribes to all chat activity upfront, but only fetches
   * histories if and when the user opens a specific.
   */
  getChatHistory(chatId: number, beforeSequence?: number): Promise<AiChatHistoryPage>;

  /** Fetch a single message from a chat thread. */
  getChatMessage(chatId: number, sequence: number): Promise<AiChatMessage | undefined>;

  /**
   * Subscribe to all new chat messages (across all threads).
   *
   * If `startAt` is given, it must be a date in the past. All messages starting from that date
   * will be sent upfront. This is intended to allow resubscribing after being disconnected. If
   * `startAt` is omitted, only new messages will be sent.
   *
   * Generally, a client should subscribe to chats immediately on loading the gadget editor. If
   * the client needs to call any methods like `listChats()` to backfill content, it should make
   * these calls after `subscribeToChat()`, so that there's no chance of missing a message. (It is
   * not necessary to wait for `subscribeToChat()` to return -- only to initiate the call before
   * other read calls.)
   */
  subscribeToChat(subscriber: RpcStub<AiChatSubscriber>, startAfter?: Date): Promise<RpcStub<{}>>;

  /**
   * Records that this client shows chat `chatId` until the returned handle is disposed. When a
   * turn finishes in a chat someone is viewing, the workspace resends that turn's last model
   * request just before the provider's cached copy of it would expire, so the user's next message
   * costs less and starts sooner. The resends are billed like the turn. They stop when the last
   * viewer leaves, at the chat's next turn, an hour after the turn, or before they would cost
   * more than the cache miss they avoid. Throws if the chat doesn't exist.
   */
  viewChat(chatId: number): Promise<RpcStub<{}>>;

  /**
   * Lists slash commands available from Gatekeepers currently attached to this Gadget, including
   * ambient ones.
   */
  listSlashCommands(): Promise<SlashCommandChoice[]>;

  /**
   * Starts a new chat with the given initial message or slash-command request. A slash command
   * always creates a visible chat event, even when it does not produce a message for the agent.
   * Slash-command requests cannot include capsules or attachments.
   *
   * `modelId` is one of the IDs in the result of `listModels()`, or null to inhibit AI response
   * (useful when using chat to talk between humans).
   *
   * `formats` records where the message names one of the deployment's standard output formats, so
   * the transcript can draw it as a chip. Display only -- what the agent reads is the noun, which
   * is already in the text.
   *
   * `bot` optionally names a declared bot to run the chat as (see AuthenticatedApi.listBots()).
   * When present it wins over `modelId`: the chat runs on the bot's model, and the bot's
   * instructions and skills join its prompt. Throws visibly if the bot, or its model, no longer
   * resolves for this user.
   */
  newChat(initialMessage: string | SlashCommandRequest, modelId: string | null,
          capsules?: CapsuleSpecifier[], attachments?: ChatAttachmentHandle[],
          formats?: MessageFormatRef[], bot?: BotSelection): Promise<number>;

  /**
   * Send a message to the chat from this client. Sending a message causes the LLM to start
   * running if it isn't already.
   * While it runs, plain text with no capsules, attachments or formats steers it, on the running
   * turn's model whatever `modelId` is, even null: it waits in `AiChatMetadata.queuedSteers` until
   * the agent reads it. Anything else, or anything sent after `stopAgent()`, throws until the
   * agent finishes.
   * If a slash command produces no message, only its visible invocation event is committed and the
   * agent does not run.
   * Slash-command requests cannot include capsules or attachments.
   *
   * `modelId` is one of the IDs in the result of `listModels()`, or null to inhibit AI response
   * (useful when using chat to talk between humans).
   *
   * `bot` switches the chat's bot: a BotSelection re-snapshots that bot (model, instructions,
   * skills) for turns from this message on -- only on an idle chat -- while "none" clears the
   * chat's bot, leaving a bare-model chat. Absent means no change (retries and steers pass
   * nothing). A selection whose bot or model no longer resolves throws visibly.
   *
   */
  sendChatMessage(chatId: number, message: string | SlashCommandRequest, modelId: string | null,
                  capsules?: CapsuleSpecifier[], attachments?: ChatAttachmentHandle[],
                  formats?: MessageFormatRef[], bot?: BotSelection | "none"): Promise<void>;

  /**
   * Store raw bytes as an immutable Git blob and return its OID after durable storage.
   * Retrying identical bytes returns the same OID. This does not change any worktree or message.
   * Use the OID in a chat attachment, or in a worktree's whole-file `setBytes` change together
   * with the payload's byte length. The blob must be present in this workspace's Git store.
   * Limited to 8,000,000 bytes; larger-file support is deferred.
   */
  uploadBlob(content: Uint8Array): Promise<GitOid>;

  /**
   * Fetch the bytes of a committed chat attachment over RPC. The canonical metadata is already
   * present in the message's ChatAttachmentRef. Images are inlined there, so this is normally used
   * only to download non-image attachments on demand.
   */
  getChatAttachmentContent(chatId: number, id: string): Promise<Uint8Array>;

  /**
   * Update the title of a chat. Usually not needed as a title is generated automatically from
   * the first message.
   */
  setChatTitle(chatId: number, title: string): Promise<void>;

  /**
   * Indicates that the user has requested that the chat's proposed changes be merged into the
   * mainline. Always merges *everything* the chat proposes -- changes not yet materialized into a
   * `changes` message are swept in first, and there is no way to accept only a subset.
   *
   * Accepting is only ever a fast-forward: every gadget touched by the merged changes must have
   * its chat pin's ChatGadgetPinState.mergedCommit equal to the gadget's current head commit.
   * If mainline has advanced past any pin, nothing at all is merged and the call returns a
   * "stale" outcome (an expected result, not an exception; see MergeChangesResult): call
   * updateChatFromMainline(), resolve any conflicts, and retry. Where the pin's `baseCommit` is
   * a merge commit not yet accepted, whose first parent is `mergedCommit`, the head moves
   * through it: to the merge commit itself if the chat changed nothing since, else to a new
   * commit on top of it.
   *
   * A chat has something to accept when it holds a pin, a gadget or binding edge pending in it,
   * or a blueprint proposal that is neither merged nor reverted. Otherwise this is a no-op and
   * records nothing.
   *
   * A successful merge closes the chat's current **epoch**: all merged content now lives in
   * commits, so the chat's code base resets to empty (every pin is dropped, the change stream
   * restarts at revision 0 under a new generation, and the merge message records
   * `epochBoundary`). Subsequent edits re-pin lazily against the new heads. The generation bump
   * is content-preserving: ChatCodeBase.prior describes the closed stream, and in-flight
   * submissions rooted in it are transformed onto the new generation rather than discarded (see
   * submitCodeChange()), so a client typing through someone's accept loses nothing.
   *
   * A blueprint release the chat proposes to merge into a gadget (see
   * AiChatMessageBody.blueprintMerges) is accepted with the rest: the gadget's new head gains
   * the release as a parent, unless its history already holds it, and the gadget follows that
   * blueprint from then on.
   */
  mergeChanges(chatId: number): Promise<MergeChangesResult>;

  /**
   * Merge mainline commits that landed after this chat's pins into the chat's uncommitted state.
   *
   * Only *pinned* gadgets participate: an unpinned gadget's code was never modified in this
   * chat, so it tracks mainline head live and there is nothing to merge into. For each pinned
   * gadget whose ChatGadgetPinState.mergedCommit is behind the gadget's current head, the server
   * computes a 3-way text merge (base = the last merged commit, ours = the head, theirs = the
   * chat's current files) and writes it as commits: the chat's files before the update, and the
   * merge commit, whose parents are the head and that (see MainlineMergeGadget). The chat's pin
   * for the gadget then re-roots at the merge commit (see ChatGadgetPinRecord), with the head as
   * its `mergedCommit`. A gadget whose files in the chat are already in the head's history had
   * nothing of its own to merge, and re-roots at the head itself. Conflicting hunks are left
   * inline as 3-way conflict markers (`<<<<<<<`/`|||||||`/`=======`/`>>>>>>>`) for the user or
   * their agent to clean up; the affected paths, each qualified by its gadget's binding name
   * (`GADGET_NAME/path`), are returned in sorted order and also recorded on the message. An
   * empty `conflictPaths` means every file merged cleanly (or there was nothing to merge).
   *
   * The update is recorded as a `changes` message carrying `mainlineMerge` and declaring the
   * re-roots, with no `change`. It then ends the chat's change stream with a destructive bump
   * of ChatCodeBase.generation, delivered after the message: clients rebuild their content from
   * the log, re-rooted. Changes a client has submitted and not yet had acknowledged are lost.
   *
   * Throws, changing nothing, if both sides changed a file and a version of it, or the merged
   * text, is too large for a file to hold; the error names the file. Making it smaller on
   * either side, or undoing the chat's own changes to it, lets the update through.
   *
   * Once the chat is up to date (and mainline hasn't moved again), mergeChanges() succeeds as a
   * plain fast-forward through the merge commit. The update can be reverted like any other
   * proposed change, which puts the pins back as they were before it (see revertChanges()).
   */
  updateChatFromMainline(chatId: number): Promise<{conflictPaths: string[]}>;

  /**
   * Indicates that the user has requested that proposed changes starting from the given sequence
   * number in the chat thread be reverted.
   *
   * Throws if the range covers a still-proposed mainline merge that records no `gadgets` (see
   * AiChatMessageBody.mainlineMerge for why such a message cannot be erased), or if the range
   * erases the chat's conversion boundary while keeping an earlier still-proposed batch (see
   * AiChatMessageBody.conversionBoundary; a revert covering everything, `revertFrom` 0, always
   * satisfies this).
   *
   * Each pin is settled from the log as it stands after the revert: its `baseCommit` is that of
   * its last surviving declaration, and a pin with none is removed from ChatCodeBase. Its
   * `mergedCommit` is put back to what the earliest update from mainline the revert covers
   * records it was before (MainlineMergeGadget.baseCommit), and is otherwise left alone.
   * Changes not yet materialized into a message are erased
   * along with the reverted range. Erasing already-applied changes invalidates every client's local
   * state -- content they may have transformed against is gone -- so ChatCodeBase.generation is
   * bumped destructively: in-flight submitCodeChange() calls fail and clients rebuild instead of
   * corrupting the chat.
   */
  revertChanges(chatId: number, revertFrom: number): Promise<void>;

  /**
   * Materialize the chat's changes not yet covered by a durable `changes` message into one, without
   * merging anything into the mainline. (Materialization also happens automatically: at agent
   * turn start, at accept, and when the un-materialized changes grow past a size/age threshold. It
   * invalidates nothing -- the message's `watermark` tells clients which changes it absorbed.)
   */
  finalizeChatDraft(chatId: number): Promise<void>;

  /**
   * Discard the chat's changes not yet materialized into a durable `changes` message, without
   * affecting any messages. Pins those changes established (and no materialized message declared)
   * are removed with them, and ChatCodeBase.generation is bumped destructively, exactly as with
   * revertChanges(): clients' content contains the erased changes, so they must rebuild. A late
   * retry of an erased change is still recognized rather than applied as new (see
   * submitCodeChange()).
   */
  discardChatDraftChanges(chatId: number): Promise<void>;

  /** Delete a chat thread. */
  deleteChat(chatId: number): Promise<void>;

  /**
   * Request that any ongoing LLM session in the given chat immediately stop.
   *
   * If an LLM is running, the session is canceled subscribers will receive a metadata update
   * reflecting this before `stop()` returns.
   *
   * If no LLM is running, `stop()` does nothing and returns immediately.
   *
   * Stopping drops the chat's queued steers (see `AiChatMetadata.queuedSteers`), whoever sent them.
   * The client that stops is expected to put them in its draft, so its user can still send them.
   */
  stopAgent(chatId: number): Promise<void>;

  /**
   * Retry the agent on the given chat. This starts the agent without adding a new user message.
   * The agent will re-process the existing chat history using the specified model.
   *
   * Throws if an agent is already running on the chat.
   */
  retryAgent(chatId: number, modelId: string): Promise<void>;

  /**
   * Subscribe to the gadget worker's console logs. This allows the user to observe console logs
   * being produced by the gadget.
   *
   * At present, logs are not stored, so the only way to see them is to be subscribed when they
   * happen.
   *
   * To unsubscribe, dispose the returned stub.
   */
  subscribeToConsoleLogs(subscriber: RpcStub<ConsoleLogSubscriber>): Promise<RpcStub<{}>>;
}

/** Blueprint operations on a workspace: listing, updating, deleting, retrying a publish, and the observer requirements a blueprint's bindings may carry. */
export interface OverseerBlueprints {

  /** List blueprints created from this workspace's gadgets. */
  listBlueprints(): Promise<BlueprintGadgetSummary[]>;

  /**
   * Update an existing blueprint. Any combination of metadata and code can be updated
   * atomically in a single call with one propagation pass.
   *
   * - `title` / `description`: if provided, update the respective field.
   * - `updateCode`: if true, release the source gadget's current committed code as the
   *   blueprint's next version. If that code is what the blueprint's latest version already
   *   holds, the version stays as it is.
   * - `updateBindings`: if true, refresh the blueprint's connection annotations from
   *   the source gadget's current bindings without changing the code snapshot.
   *
   * At least one option must be provided.
   */
  updateBlueprint(blueprintId: string, options: {
    title?: string;
    description?: string;
    updateCode?: boolean;
    updateBindings?: boolean;
    screenshot?: BlueprintScreenshotUpload | null;
  }): Promise<void>;

  /** Delete a blueprint. Cleans up KV, R2, User DO, and local storage. */
  deleteBlueprint(blueprintId: string): Promise<void>;

  /**
   * Retry publishing a blueprint whose `dirty` flag is set (meaning a previous propagation
   * to User DO / KV / R2 failed).
   */
  retryBlueprintPublish(blueprintId: string): Promise<void>;

  /**
   * List the connections a recipient with `role` must verify before opening this workspace, in
   * the order the connections were created. Reports what sharing will cost the recipient; it
   * grants nothing and mints no capability.
   */
  listObserverRequirements(role: CollaboratorRole): Promise<ObserverBindingNeed[]>;
}

/** Collaboration: the collaborator list and its edits, and share links -- creation, listing, updates, revocation previews. */
export interface OverseerCollaboration {

  /** List all collaborators. Available to owner and all collaborators. */
  listCollaborators(): Promise<CollaboratorInfo[]>;

  /**
   * Add a collaborator by username/email. The caller must be the owner or an existing
   * collaborator. `role` is the access level to grant; the caller may not grant a role higher
   * than their own effective role. Returns the new collaborator's info, or null if the username
   * doesn't correspond to an existing account.
   */
  addCollaborator(username: string, role: CollaboratorRole,
                  note?: string): Promise<CollaboratorInfo | null>;

  /**
   * Remove a collaborator (identified by profile.id).
   *
   * Owner can remove anyone. A non-owner collaborator can only remove their own edge(s)
   * from the target. If the target still has edges from other sources, they keep access
   * and the return is an empty array. If no edges remain, the target is fully removed.
   *
   * When a target is fully removed, `keepUsers` lists the profile.ids of users who would
   * lose access transitively but should be retained. Their PermissionEdges through the
   * removed user are replaced with new edges from the caller. Users reachable only through
   * the removed user who are NOT in `keepUsers` are also removed.
   *
   * Returns the list of users whose access actually changed (removed or downgraded), including
   * the primary target. An empty array means the caller's edge was removed but no one's effective
   * access changed (the target retained their role through other edges).
   */
  removeCollaborator(profileId: string, keepUsers: string[]): Promise<AffectedCollaborator[]>;

  /**
   * Preview what would happen if a collaborator were removed. For a non-owner caller,
   * if the target has edges from other sources that would survive, returns an empty array
   * (the target would not actually be affected). Otherwise, returns the list of users whose
   * access would change (lose access or be downgraded to a lower role) as a consequence, so the
   * caller can present checkboxes for which to keep vs. remove.
   */
  previewRemoveCollaborator(profileId: string): Promise<AffectedCollaborator[]>;

  /**
   * Create a share link. The server generates a random 128-bit key, stores its HMAC-SHA-256
   * hash, and returns the raw key (hex-encoded) along with the id of the link it created. The
   * caller constructs a URL from the key. The raw key is never stored server-side. `role` is the
   * access level granted to anyone who redeems the link; the caller may not grant a role higher
   * than their own effective role.
   */
  createShareLink(role: CollaboratorRole, note?: string)
      : Promise<{ key: string; linkId: string }>;

  /**
   * Mint a fresh secret for an existing link so the user can copy a new URL without creating a
   * whole new link. The old secrets remain valid, and revoking the link revokes them all together.
   */
  newShareLinkKey(linkId: string): Promise<{ key: string }>;

  /** List active share links (for management UI). */
  listShareLinks(): Promise<ShareLinkInfo[]>;

  /**
   * Update a share link's management metadata. The raw secrets are not available after creation;
   * this only edits the stored note used by the management UI.
   */
  updateShareLink(linkId: string, note?: string): Promise<void>;

  /**
   * Revoke a share link by its `linkId`, which revokes every secret ever minted for it. Users who
   * gained access through the link may be transitively removed or downgraded. `keepUsers` lists
   * profile.ids of users who should be retained at their prior role with fresh edges from the
   * caller. Returns the list of users whose access actually changed (removed or downgraded).
   */
  revokeShareLink(linkId: string, keepUsers: string[]): Promise<AffectedCollaborator[]>;

  /**
   * Preview what would happen if a share link were revoked. Returns the list of users whose access
   * would change (lose access or be downgraded to a lower role) as a consequence, so the caller
   * can present checkboxes for which to keep vs. remove.
   */
  previewRevokeShareLink(linkId: string): Promise<AffectedCollaborator[]>;
}
