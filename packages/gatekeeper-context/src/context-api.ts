// Per-account management API exposed to the library iframe. Accounts manage the private collections
// they hold a role on; admins also manage public collections. Everything is sharing-domain scoped.

import { RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import { asVerifier } from "@gadgets/gatekeeper-kit/observers";
import type { GatekeeperOrgMembership, GatekeeperUserSelectionExchange } from "@gadgets/workshop-shared/gatekeeper";
import {
  ContextApi, ContextCollectionContent, ContextCollectionMetadata, ContextCollectionPermissions,
  ContextCollectionRole, ContextCollectionSharing, ContextCollectionVisibility,
  ContextDocument, ContextDocumentSummary, ContextGitTokenCreateResult, ContextGitTokenList,
  DEFAULT_GIT_BRANCH, EnabledCollectionInfo,
} from "./context-types.js";
import type { ContextCollectionDurableObject } from "./context-collection.js";
import type { UserLibraryDurableObject } from "./user-library.js";
import type { LibraryRegistryDurableObject } from "./registry-do.js";
import type { ContextVerifierApi } from "./context-observers.js";
import { canReadCollection, collectionPermissions } from "./collection-access.js";
import { metadataToSummary } from "./collection-kv.js";
import { domainName } from "./domain.js";

const NOT_FOUND = "Collection not found or you don't have access.";

@validateRpc()
export class ContextApiImpl extends RpcTarget implements ContextApi {
  constructor(
    private env: Cloudflare.Env,
    private domain: string,
    private accountId: string,
    private isAdmin: boolean,
    private collections: DurableObjectNamespace<ContextCollectionDurableObject>,
    private userLibraries: DurableObjectNamespace<UserLibraryDurableObject>,
    private registries: DurableObjectNamespace<LibraryRegistryDurableObject>,
    private userSelectionExchange: Fetcher<GatekeeperUserSelectionExchange>,
  ) {
    super();
  }

  #collection(id: string) {
    return this.collections.get(this.collections.idFromName(domainName(this.domain, id)));
  }

  #userLib() {
    return this.userLibraries.get(this.userLibraries.idFromName(domainName(this.domain, this.accountId)));
  }

  #registry() {
    return this.registries.getByName(this.domain);
  }

  async #permissions(collectionId: string): Promise<ContextCollectionPermissions> {
    return collectionPermissions(
      await this.#collection(collectionId).getResolvedAccess(this.accountId), this.isAdmin);
  }

  async #assertCanRead(collectionId: string): Promise<void> {
    let access = await this.#collection(collectionId).getResolvedAccess(this.accountId);
    if (!canReadCollection(access)) throw new Error(NOT_FOUND);
  }

  async #assertCanEdit(collectionId: string): Promise<void> {
    if (!(await this.#permissions(collectionId)).canEdit) throw new Error(NOT_FOUND);
  }

  #userLibFor(accountId: string) {
    return this.userLibraries.get(this.userLibraries.idFromName(domainName(this.domain, accountId)));
  }

  #assertArtifactsAvailable(): void {
    if (!this.env.ARTIFACTS) {
      throw new Error("Git-backed Context collections are not enabled.");
    }
  }

  #assertAdmin(): void {
    if (!this.isAdmin) throw new Error("Admin access required.");
  }

  async getViewerInfo(): Promise<{ isAdmin: boolean; supportsGitCollections: boolean }> {
    return { isAdmin: this.isAdmin, supportsGitCollections: !!this.env.ARTIFACTS };
  }

  // --- Collection management ---

  async createContextCollection(
    title: string,
    description: string,
    visibility: ContextCollectionVisibility,
    icon?: string,
    source: ContextCollectionContent["source"] = "web",
    ownerOrgId?: string,
  ): Promise<ContextCollectionMetadata> {
    if (visibility === "public") this.#assertAdmin();
    if (source !== "web" && source !== "git") {
      throw new Error(`Unsupported collection source: ${source}`);
    }
    if (source === "git" && !this.env.ARTIFACTS) {
      throw new Error("Git-backed Context collections are not enabled.");
    }
    if (ownerOrgId !== undefined && visibility !== "private") {
      throw new Error("Only private collections can be owned by an org.");
    }
    if (ownerOrgId !== undefined) {
      // The actor's own recorded membership is the only org authority this gatekeeper has;
      // only an org's owner or admin may spend its name on a new collection.
      let memberships = await this.#userLib().listOrgMemberships(this.domain, this.accountId);
      let membership = memberships.find(entry => entry.orgId === ownerOrgId);
      if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
        throw new Error("You must own or administer this org to create collections for it.");
      }
    }

    let id = crypto.randomUUID();
    let metadata: ContextCollectionMetadata = {
      id,
      icon,
      title,
      description,
      visibility,
      created: new Date(),
      lastUpdated: new Date(),
      documentCount: 0,
      content: source === "git"
        ? { source, remote: "", branch: DEFAULT_GIT_BRANCH, lastRefreshedAt: new Date() }
        : { source },
    };

    // Initialize before indexing; if this fails, nothing is reachable yet.
    metadata = await this.#collection(id).initialize(
      metadata, this.domain, visibility === "private" ? this.accountId : "", ownerOrgId ?? "");

    // The creator's library indexes private collections, the registry's org index covers
    // org-owned ones, and the domain registry holds public ones.
    try {
      if (visibility === "public") {
        await this.#registry().addPublic(this.domain, metadataToSummary(metadata));
      } else if (ownerOrgId !== undefined) {
        await this.#registry().addOrgCollection(this.domain, ownerOrgId, id);
      } else {
        await this.#userLib().createOwnedCollection(id);
      }
    } catch (err) {
      // Indexing failed; delete the now-unreachable collection.
      await this.#collection(id).deleteSelf(this.accountId, this.isAdmin).catch(() => {});
      throw err;
    }
    return metadata;
  }

  async updateContextCollection(collectionId: string, options: {
    title?: string; description?: string; icon?: string; branch?: string;
  }): Promise<void> {
    await this.#assertCanEdit(collectionId);
    if (options.branch !== undefined) this.#assertArtifactsAvailable();
    await this.#collection(collectionId).updateMetadata(options);
  }

  async syncContextCollectionArtifactSource(collectionId: string): Promise<void> {
    // Only editors can manually trigger an artifact sync. Reads by anyone may trigger a
    // stale-while-revalidate sync in the background, but they do not have direct control over this.
    await this.#assertCanEdit(collectionId);
    this.#assertArtifactsAvailable();
    await this.#collection(collectionId).syncArtifactSource();
  }

  async createContextCollectionGitToken(collectionId: string): Promise<ContextGitTokenCreateResult> {
    await this.#assertCanEdit(collectionId);
    this.#assertArtifactsAvailable();
    return this.#collection(collectionId).createGitToken(this.accountId);
  }

  async listContextCollectionGitTokens(collectionId: string): Promise<ContextGitTokenList> {
    await this.#assertCanEdit(collectionId);
    this.#assertArtifactsAvailable();
    return this.#collection(collectionId).listGitTokens();
  }

  async revokeContextCollectionGitToken(collectionId: string, tokenId: string): Promise<boolean> {
    await this.#assertCanEdit(collectionId);
    this.#assertArtifactsAvailable();
    return this.#collection(collectionId).revokeGitToken(tokenId);
  }

  async deleteContextCollection(collectionId: string): Promise<void> {
    await this.#collection(collectionId).deleteSelf(this.accountId, this.isAdmin);
  }

  async getContextCollectionMetadata(collectionId: string): Promise<ContextCollectionMetadata | null> {
    try {
      let collection = this.#collection(collectionId);
      let [meta, access] = await Promise.all([
        collection.getMetadata(),
        collection.getResolvedAccess(this.accountId),
      ]);
      if (!canReadCollection(access)) return null;
      return meta;
    } catch {
      return null;
    }
  }

  // The actor's resolved access: account grants, plus org grants its recorded memberships pick
  // up. Checked here so every sharing entry point resolves the same way.
  async #assertCanShare(collectionId: string, role: ContextCollectionRole): Promise<void> {
    let access = await this.#collection(collectionId).getResolvedAccess(this.accountId);
    let permissions = collectionPermissions(access, this.isAdmin);
    if (access.visibility !== "private" || !permissions.canShare) throw new Error(NOT_FOUND);
    if (role === "owner" && !permissions.canManageOwners) {
      throw new Error("Only owners can change who owns this collection.");
    }
  }

  // --- Document editing ---

  async listContextDocuments(collectionId: string, prefix?: string): Promise<ContextDocumentSummary[]> {
    await this.#assertCanRead(collectionId);
    return this.#collection(collectionId).listContextDocuments(prefix);
  }

  async getContextDocument(collectionId: string, path: string): Promise<ContextDocument | null> {
    await this.#assertCanRead(collectionId);
    return this.#collection(collectionId).getContextDocument(path);
  }

  async putContextDocument(collectionId: string, path: string, doc: {
    description: string; body: string; contentType?: string;
  }): Promise<void> {
    await this.#assertCanEdit(collectionId);
    await this.#collection(collectionId).putContextDocument(path, doc);
  }

  async createContextSkill(collectionId: string, path: string, doc: {
    description: string; body: string; contentType?: string;
  }): Promise<void> {
    await this.#assertCanEdit(collectionId);
    await this.#collection(collectionId).createContextSkill(path, doc);
  }

  async deleteContextDocument(collectionId: string, path: string): Promise<void> {
    await this.#assertCanEdit(collectionId);
    await this.#collection(collectionId).deleteContextDocument(path);
  }

  async deleteContextSkill(collectionId: string, manifestPath: string): Promise<void> {
    await this.#assertCanEdit(collectionId);
    await this.#collection(collectionId).deleteContextSkill(manifestPath);
  }

  async deleteContextDocumentTree(collectionId: string, path: string): Promise<void> {
    await this.#assertCanEdit(collectionId);
    await this.#collection(collectionId).deleteContextDocumentTree(path);
  }

  async moveContextDocument(collectionId: string, fromPath: string, toPath: string): Promise<void> {
    await this.#assertCanEdit(collectionId);
    await this.#collection(collectionId).moveContextDocument(fromPath, toPath);
  }

  async moveContextSkill(
    collectionId: string,
    manifestPath: string,
    directoryPath: string,
  ): Promise<void> {
    await this.#assertCanEdit(collectionId);
    await this.#collection(collectionId).moveContextSkill(manifestPath, directoryPath);
  }

  async renameContextSkill(
    collectionId: string,
    manifestPath: string,
    newName: string,
  ): Promise<void> {
    await this.#assertCanEdit(collectionId);
    await this.#collection(collectionId).renameContextSkill(manifestPath, newName);
  }

  // --- Listing & access ---

  async listEnabledContextCollections(): Promise<EnabledCollectionInfo[]> {
    return this.#userLib().listLibrary(this.domain, this.accountId);
  }

  async getContextCollectionPermissions(collectionId: string): Promise<ContextCollectionPermissions> {
    return this.#permissions(collectionId);
  }

  // --- Sharing ---

  async getContextCollectionSharing(collectionId: string): Promise<ContextCollectionSharing> {
    return this.#collection(collectionId).getSharing(this.accountId);
  }

  async shareContextCollection(
      collectionId: string, ticket: string, role: ContextCollectionRole): Promise<void> {
    // Checked before spending the single-use ticket; the collection checks again when granting.
    await this.#assertCanShare(collectionId, role);
    let collection = this.#collection(collectionId);

    let selections = await this.userSelectionExchange.redeem(ticket);
    // Only a Context verifier in this sharing domain names an account; the browser cannot. A
    // failure to ask is not mistaken for an account elsewhere: it rejects, and the share can be
    // retried with a new selection.
    let recipients = (await Promise.all(selections.map(async ({ verifier, profile, orgMemberships }) => ({
      accountId: await asVerifier<Fetcher<ContextVerifierApi>>(verifier).getAccountId(this.domain),
      displayName: profile.displayName,
      orgMemberships,
    })))).filter((recipient): recipient is {
      accountId: string; displayName: string; orgMemberships: GatekeeperOrgMembership[] | undefined;
    } => recipient.accountId !== null);
    if (recipients.length === 0) {
      throw new Error("This person hasn't turned on Skills yet, so you can't share with them.");
    }
    // Snapshot what the Workshop reports about the recipient's orgs, when it says anything, so
    // org grants resolve for their accounts from the moment the share lands. Absent field:
    // whatever was recorded stays.
    await Promise.all(recipients.map(recipient => recipient.orgMemberships === undefined
      ? undefined
      : this.#userLibFor(recipient.accountId)
        .syncOrgMemberships(this.domain, recipient.accountId, recipient.orgMemberships)));
    // Every result is an account of the one person selected, so sharing with each of them gives
    // that person nothing beyond what was chosen. One call, so their grants land together.
    await collection.share(this.accountId, recipients, role);
  }

  async shareContextCollectionWithOrg(
      collectionId: string, orgId: string, role: ContextCollectionRole): Promise<void> {
    await this.#assertCanShare(collectionId, role);
    await this.#collection(collectionId).shareOrg(this.accountId, orgId, role);
  }

  async setContextCollectionMemberRole(
      collectionId: string, memberId: string, role: ContextCollectionRole): Promise<void> {
    await this.#collection(collectionId).setMemberRole(this.accountId, memberId, role);
  }

  async removeContextCollectionMember(collectionId: string, memberId: string): Promise<void> {
    await this.#collection(collectionId).removeMember(this.accountId, memberId);
  }

  async leaveContextCollection(collectionId: string): Promise<void> {
    await this.#collection(collectionId).removeMember(this.accountId, this.accountId);
  }

  async setContextCollectionEveryoneCanView(
      collectionId: string, everyoneCanView: boolean): Promise<void> {
    await this.#collection(collectionId).setEveryoneCanView(this.accountId, everyoneCanView);
  }
}
