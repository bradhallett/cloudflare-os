import { RpcStub, RpcTarget } from "capnweb";
import { Overseer, ConsoleLogEvent, CollaboratorRole, ObserverConfigCallback, BlueprintMetadata, BlueprintOutput, createOpenGadgetError, OPEN_GADGET_ERROR_CODES, resolveSiteName } from "@gadgets/workshop-shared/api";
import { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import { DurableObject, RpcStub as NativeRpcStub, restore } from "cloudflare:workers";
import { chatKeyPrefix } from "./storage-schema/overseer-storage";
import type { BlueprintOwnerSubject } from "./storage-schema/blueprints-kv";
import type { ExternalChatRecord, GatekeeperCaller } from "./storage-schema/overseer-storage";
import type { WorkspaceOutputEntry } from "./storage-schema/user-storage";
import { commitIdentityForAuthor } from "./git-store";
import { OVERSEER_STORAGE_VERSION } from "./storage-schema/overseer-migrations";
import { readAdminConfig } from "./admin-config";
import { ambientGatekeeperMode } from "./provisioning-policy";
import { releaseMergeHeader } from "./blueprint-release";
import { retryOnDoReset } from "./do-retry";
import type { SubmitExternalMessageResult } from "@gadgets/workshop-shared/external-message-gateway";
import { OverseerImpl } from "./overseer-impl";
import { UseOverseerInterface } from "./overseer-client-use";
import { OverseerClientInterface } from "./overseer-client";
import type { ExternalMessageResponseTargetRegistration, ExternalMessageSubmitInput, OverseerRestoreParams } from "./overseer-support";
import { stringifyError } from "./overseer-support";
import type { BindingLoopbackTarget } from "./overseer-loopbacks";
import { ApprovalQueueImpl, makeHookFiringCallback, requireLiveHook } from "./overseer-gatekeeper-client";
import { gatekeeperVendorId } from "./overseer-binding-info";

export class OverseerDurableObject extends DurableObject<Cloudflare.Env> {
  private impl: OverseerImpl;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.impl = new OverseerImpl(ctx, env);
  }

  /**
   * The DO's one alarm (scheduled by #updateAlarm for the earliest time any concern below needs
   * it) does all of the following, so whichever concern set it, none is missed:
   * - Agent work outstanding for at least a minute -- a running turn, or a recorded call to a
   *   callable agent not yet appended to its chat. If the DO is still running when this is called,
   *   but the client has closed their browser and so isn't holding the DO alive anymore, the alarm
   *   handler takes over and holds the DO open until the work is done. If the DO died meanwhile,
   *   the alarm wakes it (and the constructor resumes the turns and drains the calls before
   *   alarm() itself runs). If the DO dies *while* the alarm is running, the system retries the
   *   alarm, picking the work up yet again.
   * - External-message responses ready to deliver, and delivered records due to be swept.
   *
   * See OverseerImpl.runAlarmTasks for how the concerns are run together.
   */
  async alarm(info?: AlarmInvocationInfo) {
    await this.impl.runAlarmTasks(info?.retryCount);
  }

  // Initialize a brand-new workspace's storage. (Before git-backed code storage this also wrote
  // an empty Yjs snapshot as legacy code version 1; workspaces born since have no legacy code
  // log at all -- committed code exists only once a first commit lands in the git store.)
  #initializeNewWorkspace(): void {
    this.impl.storage.codeVersion.put(1);

    // A workspace initialized by this version of the code is born at the current schema version;
    // there is nothing to migrate.
    this.impl.storage.version.put(OVERSEER_STORAGE_VERSION);
  }

  /**
   * This workspace's outputs, for the owner to fold into their index. Every registry change and
   * every owner open already pushes, so this exists only to catch up workspaces that predate the
   * index. Null unless the caller really is the owner, so nobody else can read the snapshot.
   */
  async getOutputsForOwnerBackfill(ownerId: string): Promise<WorkspaceOutputEntry[] | null> {
    if (this.impl.ownerId !== ownerId) return null;
    return this.impl.outputsSnapshot();
  }

  /**
   * Sever every sharing edge granting `profileId` access to this workspace — an owner-style
   * removal (all incoming edges), without a session, called by the user's Durable Object while
   * deprovisioning them (UserDurableObject.#severSharedWorkspaceAccess). Like
   * removeCollaborator, a workspace that actually lost the user is force-restarted
   * (scheduleAccessRestart), so their live chat sessions die with the restart rather than at
   * their next re-open, and the best-effort cleanup after the restart (observer teardown,
   * listing refresh) self-heals lazily if the abort cuts it off. A no-op when `profileId` holds
   * no collaborator record here (never shared, or the owner themself).
   */
  async severCollaboratorAccess(profileId: string): Promise<void> {
    let sharing = await this.impl.getSharingManager();
    if (!sharing.isCollaborator(profileId)) return;
    let affected = await sharing.removeCollaborator(
        { profileId: await this.impl.getOwnerProfileId(), isOwner: true }, profileId, []);
    if (affected.length > 0) {
      this.impl.scheduleAccessRestart(
          "Gadget restarted to revoke access for a deprovisioned user.");
      // Fire-and-forget, as in the ownerInvitesOnly sweep: awaiting cross-DO cleanup would let
      // the scheduled abort reject this call (and stall the caller's deprovision) whenever the
      // cleanup loses the race.
      this.impl.tearDownLostObservers(affected)
          .then(() => this.impl.refreshAffectedCollaboratorListings(affected))
          .catch(err => {
            this.impl.logger.warn("failed to clean up after deprovisioning removed a collaborator", {
              event: "deprovision.collaborator.cleanup.failed", error: err,
            });
          });
    }
  }

  /**
   * The owning org reports that a membership ended or narrowed (removed, left, or demoted --
   * see OrgDurableObject.#severOwnedGadgetSessions). Access recompute is lazy like every
   * revocation here: this only force-restarts live sessions (the existing entitlement-change
   * path), making every caller's next open() re-check the org's live membership and land at
   * their new -- possibly absent -- role. Sessions are counted by role, not by member
   * (hasCollaboratorSession), so the restart is conservative: it severs all of them when any is
   * live, and each reconnect re-authorizes. An authority call from the org DO, so it takes no
   * actor and names no member -- the sever is the same whoever changed. No-op on a user-owned
   * workspace (the org's index cannot name one; a stale entry costs nothing).
   */
  async severOrgMemberSessions(): Promise<void> {
    if (this.impl.workspaceOwner()?.type !== "org") return;
    if (this.impl.hasCollaboratorSession()) {
      this.impl.scheduleAccessRestart(
          "Gadget restarted because your organization membership changed.");
    }
  }

  /**
   * `notifyClosed` should be invoked when the return `Overseer` stub is disposed, which is used
   * by AuthenticatedApiImpl.#openGadgetInternal() to detect Durable Object disconnects.
   */
  async open(userId: string, profileId: string,
             notifyClosed: NativeRpcStub<() => void>,
             shareKey?: string,
             configureObservers?: RpcStub<ObserverConfigCallback>): Promise<Overseer> {
    let firstOpen = !this.impl.ownerId;
    if (firstOpen) {
      // This Overseer hasn't been initialized yet.
      await this.ctx.blockConcurrencyWhile(async () => {
        // Verify that the owner believes it exists. The owner account must be initialized with
        // any new gadgets first before the gadget is actually opened.
        let owner = this.impl.users.get(this.impl.users.idFromString(userId));
        let meta = await owner.getGadget(this.ctx.id.toString());
        if (!meta) {
          throw createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceNotFound);
        }
        if (meta.owner) {
          // The user's DO contains a record indicating that this gadget was shared to them by
          // some other owner. This gadget may have existed in the past, and then was deleted,
          // which does not proactively clean up share recipient's references. We need to treat
          // this as missing otherwise we'll inadvertently create a new gadget with this ID
          // belonging to a different user than the original.
          throw createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceNotFound);
        }

        // Owner says we exist, so let's initialize ourselves.
        this.impl.ownerId = userId;

        this.impl.storage.ownerId.put(userId);

        this.#initializeNewWorkspace();
      });
    }

    let isOperatingOwner = (userId == this.impl.ownerId);
    // An org-owned workspace (see transferToOrg) has no user owner: every caller -- the
    // operating owner included -- is authorized through the sharing graph, which baselines each
    // active org member's role at their org role and re-checks membership live on every open.
    let isOwner = isOperatingOwner && this.impl.workspaceOwner()?.type !== "org";

    // Cache the owner's profileId in memory when the owner opens.
    if (isOperatingOwner) {
      this.impl.ownerProfileId = profileId;
    }

    // Make singleton gatekeepers (e.g. the Context Library) available to the agent as unnamed
    // capsules. Idempotent and best-effort, so a library hiccup never blocks opening the gadget.
    // On the very first open we block so the agent's first turn sees the capsules; later opens let the
    // reconcile run in the background to keep cross-DO latency off the hot path.
    let ensureCapsules = this.impl.ensureAmbientCapsules().catch((err) => {
      this.impl.logger.error("failed to ensure singleton gatekeeper capsules", {
        event: "singleton.capsules.ensure.failed", error: err,
      });
    });
    if (firstOpen) {
      await ensureCapsules;
    }

    let owner = this.impl.users.get(this.impl.users.idFromString(this.impl.ownerId!));
    let clientUser = isOperatingOwner
        ? owner
        : this.impl.users.get(this.impl.users.idFromString(userId));

    // Refresh the owner's outputs index. Pushes are best-effort, and workspaces predating the
    // index have never pushed at all, so re-syncing on open is what corrects both.
    if (isOperatingOwner) {
      this.impl.markOutputsDirty();
    }

    // The caller's effective role. The owner always has "build".
    let role: CollaboratorRole = "build";

    if (!isOwner) {
      let sharing = await this.impl.getSharingManager();

      // If a share key was provided, redeem it. The owner already has full access and should not
      // appear in the collaborators table; the operating owner of an org-owned workspace neither
      // (their access is their org membership, and redeeming would only add a stale edge).
      if (shareKey && !isOperatingOwner) {
        await sharing.redeemShareKey({
          rawKey: shareKey,
          profileId,
          fetchProfile: () => clientUser.whoami(),
        });
      }

      // Ambient reconciliation may attach Gatekeepers after open() starts. Finish it before taking
      // the observer snapshot so every capability exposed to this collaborator has an observer.
      await ensureCapsules;

      // Check authorization: compute the caller's effective role from the permission graph, then
      // verify they may observe everything this Gadget has read through its in-scope gatekeepers,
      // configuring their connected accounts if needed. Observer verification runs only after a
      // valid role is confirmed, so it never reveals gatekeeper or resource metadata to an
      // unauthorized user.
      //
      // An unauthorized caller (no effective role -- never had access, was removed, or lost their
      // org membership) gets a distinct denial without workspace metadata. A removed collaborator
      // who reconnects after their session is force-restarted lands here and sees the terminal
      // access-denied page.
      let effectiveRole = await this.impl.authorizeCollaborator(
          profileId, clientUser, {configureCb: configureObservers});
      if (!effectiveRole) {
        throw createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied);
      }
      role = effectiveRole;

      // Fire-and-forget a call to the collaborator's user DO so the gadget appears on
      // (or is refreshed on) their home page.
      if (!isOperatingOwner) {
        let title = this.impl.storage.title.get();
        let gadgetId = this.impl.ctx.id.toString();
        void (async () => {
          try {
            const ownerProfile = await owner.whoami();
            await clientUser.recordSharedGadgetOpen(gadgetId, title, ownerProfile, role);
          } catch (err) {
            this.impl.logger.warn("failed to record shared gadget open", {
              event: "shared.gadget.open.record.failed", gadgetId, error: err,
            });
            return;
          }
          // Catch up whatever happened while they were away; changes from here on reach them
          // through the session fan-out (joinOutputsFanout).
          await this.impl.syncOutputsTo(clientUser);
        })();
      }
    }

    this.impl.recordGadgetAnalytics({
      event_name: "gadget_opened",
      user_id: userId,
      source: shareKey ? "share_key" : "direct",
    });

    if (role === "use") {
      // "use" collaborators get a restricted capability exposing only the gadget UI.
      return new UseOverseerInterface(
          this.impl, profileId, userId, notifyClosed.dup());
    }

    return new OverseerClientInterface(
        this.impl, profileId, userId, isOwner, notifyClosed.dup(),
        ensureCapsules);
  }

  #getExternalChat(externalChatKey: string): ExternalChatRecord | undefined {
    let externalChat = this.impl.storage.externalChats.get(externalChatKey);
    if (externalChat && !this.impl.storage.chatMeta.get(externalChat.chatId)) {
      this.impl.storage.externalChats.delete(externalChat.externalChatKey);
      externalChat = undefined;
    }
    return externalChat;
  }

  async receiveExternalMessage(
    input: ExternalMessageSubmitInput,
  ): Promise<SubmitExternalMessageResult> {
    if (!input.prompt.trim()) {
      return { accepted: false, message: "Please include a prompt." };
    }

    // Resolve the caller.
    let caller = this.impl.users.getByName(input.callerEmail);
    let callerId = caller.id.toString();
    let callerProfile = await caller.whoamiIfExists();
    if (!callerProfile) {
      let siteName = resolveSiteName((await readAdminConfig(this.impl.env)).siteName);
      return {
        accepted: false,
        message: `Please create a ${siteName} account to continue.`,
      };
    }

    // Create the Gadget if it doesn't exist yet. Registering it with its (about-to-be) owner
    // comes FIRST: the registry row is the same plan-capped write a browser newGadget makes, so
    // an at-cap plan is refused here — before this Durable Object holds any workspace state it
    // could be locked out of. newGadget is idempotent per workspace, so a message retried after
    // a crash between the two writes completes rather than being re-refused by its own row.
    let ownerId = this.impl.ownerId;
    if (!ownerId) {
      let caller = this.impl.users.get(this.impl.users.idFromString(callerId));
      try {
        await caller.newGadget(this.ctx.id.toString(), input.title);
      } catch (err) {
        return { accepted: false, message: stringifyError(err) };
      }
      this.impl.ownerId = callerId;
      this.impl.ownerProfileId = callerProfile.id;
      this.impl.storage.ownerId.put(callerId);
      this.impl.storage.title.put(input.title);
      this.#initializeNewWorkspace();
      ownerId = callerId;
      this.impl.recordGadgetAnalytics({
        event_name: "gadget_created",
        user_id: callerId,
        source: "external_message",
      });
    }

    // A non-owner caller counts as a live "build" session from the moment they are authorized
    // until this call completes: their reply is produced from whatever the workspace holds, and
    // this path never constructs one of the counted client interfaces, so without a lease a scope
    // widening mid-call would find no session to sever and the reply would be produced under
    // stale verification. With it, the widening resets the DO, this call dies with it, and the
    // caller retries. The lease deliberately starts only after authorizeCollaborator returns:
    // verification itself is covered by that call's own internal lease, and a caller it turns
    // away must never have counted at all -- a stranger racing an addGatekeeper would otherwise
    // cause a needless workspace reset. The fire-and-forget turn then takes its own build lease
    // for its whole run (see startAgent), so the handoff between the two leases is
    // microtask-only, the same argument as open()'s.
    let leaveSession = () => {};
    using _sessionLease = {[Symbol.dispose]: () => leaveSession()};

    // Caller must be the owner or a build collaborator. The agent's reply can surface anything
    // the workspace has already read (chat history, gadget storage), so a collaborator passes the
    // same authorization gate as open() -- but non-interactively: with no way to configure
    // accounts here, an unverified caller is sent to open the workspace, which is where
    // verification happens. Requiring "build" up front means a "use" collaborator gets the plain
    // denial below rather than being verified (or told to fix a verification failure) for access
    // this path can never grant them.
    if (ownerId !== callerId) {
      let role: CollaboratorRole | null;
      try {
        role = await this.impl.authorizeCollaborator(
            callerProfile.id, caller, {requireRole: "build"});
      } catch (err) {
        return {
          accepted: false,
          message: "Your access to the data this workspace has read could not be verified. Open " +
              "the workspace in your browser to verify your access, then try again. " +
              `(${stringifyError(err)})`,
        };
      }
      if (role !== "build") {
        return {
          accepted: false,
          message: "You do not have access to interact with this workspace through its agent.",
        };
      }
      leaveSession = this.impl.joinSession("build");
    }

    // Complete a registration left pending by a claim that predates the register-first order
    // above (or died between its writes). The workspace already exists, so this is the
    // cap-exempt ensureGadgetRegistered: a plan cap must never lock an owner out of a workspace
    // this object already holds.
    if (this.impl.storage.ownerRegistrationPending.get()) {
      let owner = this.impl.users.get(this.impl.users.idFromString(ownerId));
      await owner.ensureGadgetRegistered(this.ctx.id.toString(), this.impl.storage.title.get());
      this.impl.storage.ownerRegistrationPending.put(false);
    }

    // Find the external conversation's chat if it exists.
    let externalChat = this.#getExternalChat(input.externalChatKey);
    let modelId = null;
    if (externalChat) {
      // Continue existing chats with the most recent agent model used in that chat.
      for (let msg of this.impl.storage.chats.list({ prefix: chatKeyPrefix(externalChat.chatId), reverse: true })) {
        if (msg.author.type === "agent") {
          modelId = msg.author.id;
          break;
        }
      }
    }

    // Resolve the caller's profile and model.
    let userContext = await caller.getExternalMessageChatContext(modelId);

    // The caller must have an available agent model.
    let aiModel = userContext.aiModel;
    if (!aiModel) {
      let siteName = resolveSiteName((await readAdminConfig(this.impl.env)).siteName);
      return {
        accepted: false,
        message: `Your ${siteName} account needs an AI model configured before it can respond.`,
      };
    }

    // Re-check because another request may have created the external chat while resolving the model.
    externalChat = this.#getExternalChat(input.externalChatKey);

    // Submit the prompt to the existing external chat, or start a new external chat.
    let responseTargetRegistration: ExternalMessageResponseTargetRegistration = {
      idempotencyKey: input.idempotencyKey,
      chatGatewayRpcTarget: input.chatGatewayRpcTarget,
    };
    let chatId: number;
    if (externalChat) {
      await this.impl.sendChatMessage(
        caller,
        userContext,
        externalChat.chatId,
        input.prompt,
        undefined,
        undefined,
        responseTargetRegistration,
      );
      chatId = externalChat.chatId;
    } else {
      chatId = await this.impl.newChat(
        caller,
        userContext,
        input.prompt,
        undefined,
        undefined,
        responseTargetRegistration,
        input.externalChatKey,
      );
    }

    return { accepted: true, chatPath: `/workspace/${this.ctx.id.toString()}?chat=${chatId}` };
  }

  /**
   * Initialize this workspace's default gadget from the release of a blueprint that `metadata`
   * describes. Called by AuthenticatedApi.newGadgetFromBlueprint() after creating (and opening)
   * the DO, with the metadata it goes on to set up the gadget's bindings from: the blueprint may
   * be republished meanwhile, and the code has to be the version those bindings belong to.
   * `owner` is the blueprint's owner subject, which scopes the content it reads.
   */
  async initializeFromBlueprint(
      blueprintId: string, metadata: BlueprintMetadata, output?: BlueprintOutput,
      blueprintOwner?: BlueprintOwnerSubject): Promise<void> {
    // Set the title. The default gadget (created below) inherits it.
    let { title } = metadata;
    this.impl.storage.title.put(title);

    // Load the release and write the gadget's initial commits *before* creating the gadget
    // record: every permanent gadget is born with a head (see GadgetRecord.commitId), so a
    // failure here -- invalid content, an empty release, an unreachable owner -- must not leave
    // a headless record behind. The commits are content-addressed and referenced by nothing
    // until the record lands, so writing them first is safe. The release's tree becomes the
    // gadget's first committed tree. An empty release is refused rather than instantiated as a
    // code-less gadget: blueprints of such gadgets cannot be created (see createBlueprint), so
    // one can only arrive corrupted or hand-crafted.
    let release = await this.impl.loadBlueprint(blueprintId, metadata, blueprintOwner);
    if ((await this.impl.gitStore.readCommitFiles(release)).size === 0) {
      throw new Error("This blueprint's code archive is empty.");
    }
    let ownerId = this.impl.ownerId;
    if (!ownerId) {
      throw new Error("Workspace has no owner.");
    }
    // Fresh stub per call, so the pure whoami() read below is safe to retry once across a
    // user-DO reset (see retryOnDoReset: a captured stub would be permanently broken).
    let owner = () => this.impl.wrapUserDo(
        this.impl.users.get(this.impl.users.idFromString(ownerId)));
    let ownerProfile = await retryOnDoReset(() => owner().whoami(), this.impl.logger);

    // The gadget's history starts at an empty root of its own, into which its head merges the
    // release: the head's tree is the release's, its first parent the root, its second the
    // release, which it marks as a release it merged (see releasesMergedSince). A commit's first
    // parent is always the gadget's own previous state, so the gadget's first-parent chain is its
    // own history, every commit of which has its tree here. The release's ancestors, most of
    // which arrived without theirs, are only ever reached through other parents -- where a later
    // update finds what the gadget and a blueprint have in common.
    let authorship = { author: commitIdentityForAuthor(ownerProfile), timestamp: new Date() };
    let root = await this.impl.gitStore.writeFilesAsCommit(new Map(), {
      ...authorship,
      parents: [],
      message: `Create gadget: ${title}`,
    });
    let commitId = await this.impl.gitStore.writeCommitForTree(
        await this.impl.gitStore.commitTree(release), {
      ...authorship,
      parents: [root, release],
      message: `Instantiate blueprint: ${title}`,
      headers: [releaseMergeHeader(release)],
    });

    // Blueprint instantiation still creates a fresh workspace containing one auto-created gadget,
    // recorded as the default gadget (see ensureDefaultGadget).
    let gadgetId = this.impl.ensureDefaultGadget(commitId);
    this.impl.recordGadgetAnalytics({
      event_name: "workpiece_created",
      user_id: ownerId,
      workpiece_id: gadgetId,
      source: "blueprint",
    });

    // The gadget follows the blueprint, from the release it was built from. It also inherits the
    // blueprint's declared format, so it is named and drawn as a Document (or whatever it
    // produces) rather than a generic app.
    let record = this.impl.getGadgetRecord(gadgetId);
    record.upstream = { blueprintId, commitId: release };
    if (output) {
      record.output = output;
    }
    this.impl.storage.gadgets.put(record);

    // Mark gadget as non-provisional (it has code, so it should appear in the gadget list).
    // (A write, so deliberately not retried -- a reset can't distinguish "never applied" from
    // "applied, response lost".)
    await owner().setGadgetLastActive(this.ctx.id.toString(), new Date(), undefined);
  }

  async startGatekeeperSession(
      target: BindingLoopbackTarget, caller: GatekeeperCaller): Promise<any> {
    return this.impl.startGatekeeperSession(target, caller);
  }

  async startHook(hookId: number): Promise<{
    callback: NativeRpcStub<RpcTarget>, approvalQueue: ApprovalQueue
  }> {
    let record = requireLiveHook(this.impl, hookId);

    let vendorId = record.vendorId ??
        gatekeeperVendorId(this.impl.storage.gatekeepers.get(record.gatekeeperId));
    if (!vendorId) throw new Error("Hook vendor is unavailable.");

    let config = await readAdminConfig(this.env);
    if (config.disabledGatekeepers.includes(vendorId) ||
        ambientGatekeeperMode(config, vendorId) === "disabled") {
      throw new Error("Gatekeeper is disabled.");
    }

    // Re-read after the await: the KV read leaves the input gate open, so a disable/delete may
    // have landed while it was in flight, and issuing from the captured record would hand out a
    // firing on a dead hook (the enableHookRecord/disableHook idiom).
    record = requireLiveHook(this.impl, hookId);

    // Both returned capabilities revalidate the hook per call rather than trusting this moment:
    // they are held outside this DO (even across resets -- the stored callback is a persistent
    // stub), so this is what ties them to the firing, per the session contract documented on
    // Gatekeeper.bindHook (workshop-shared/gatekeeper.ts).
    return {
      callback: makeHookFiringCallback(this.impl, hookId),
      approvalQueue: new ApprovalQueueImpl(this.impl, record.gatekeeperId, {from: "hook"}, hookId),
    };
  }

  async deliverGadgetLogs(chatId: number | null, logs: ConsoleLogEvent[]) {
    return this.impl.deliverGadgetLogs(chatId, logs);
  }

  async deliverCodeModeTrace(executionId: string, trace: TraceItem) {
    return this.impl.deliverCodeModeTrace(executionId, trace);
  }

  deliverCodeModeText(executionId: string, delta: string) {
    return this.impl.deliverCodeModeText(executionId, delta);
  }

  /** Called by AgentSelfLoopback when any method is called on the `self` object. */
  deliverAgentCallback(
      chatId: number, methodName: string, args: unknown[],
      initiatorUserId: string, initiatorModelId: string | null): Promise<void> {
    return this.impl.deliverAgentCallback(
        chatId, methodName, args, initiatorUserId, initiatorModelId);
  }


  [restore](params: OverseerRestoreParams): any {
    return this.impl.restore(params);
  }
}
