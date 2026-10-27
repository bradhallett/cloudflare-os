// The Spotify gatekeeper Durable Object: playlist caching and simulation, the private API
// surface the action engine drives, and session construction. The OAuth account and HTTP
// entrypoint live in spotify.ts; sessions and configurators in their own modules.

import {
  DurableObject,
  RpcStub,
} from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import {
  ApprovalQueue,
  type Gatekeeper,
  type GatekeeperUserVerifier,
  type ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  SpotifyApi,
  SpotifyApiError,
  type SpotifyPlaylistItemResponse,
} from "./spotify-api";
import {
  type SpotifyAccountSession,
  type SpotifyAlbumRef,
  type SpotifyArtistRef,
  type SpotifyDevice,
  type SpotifyPlaybackState,
  type SpotifyPlayHistoryEntry,
  type SpotifyPlaylist,
  type SpotifyPlaylistSummary,
  type SpotifyPlaylistTrack,
  type SpotifyProfile,
  type SpotifySearchResults,
  type SpotifySearchType,
  type SpotifyTopTimeRange,
  type SpotifyTrack,
  type SpotifyUserRef,
  type SpotifyPlaylistDetailsUpdate,
} from "./types";
import TYPES_CODE from "./types.txt";

import { type Env, type SpotifyGatekeeperImplProps } from "./spotify-env";
import {
clampLimit,
  clampOffset,
  externalUrl,
  normalizeAlbumRef,
  normalizeArtistRef,
  normalizeDevice,
  normalizePlaybackState,
  normalizePlaylistSummary,
  normalizeProfile,
  normalizeTimeRange,
  normalizeTrack,
  normalizeUserRef,
  playlistUrl,
  profileUrl,
} from "./spotify-normalize";
import {
type BaseAction,
  type FollowArtistsAction,
  METADATA_CHUNK,
  PLAYLIST_CACHE_TTL_MS,
  PLAYLIST_FETCH_CONCURRENCY,
  PLAYLIST_MATERIALIZE_CAP,
  PLAYLIST_WRITE_CHUNK,
  type PlayerAction,
  type PlayerCommand,
  type PlaylistAddAction,
  type PlaylistCreateAction,
  type PlaylistDetailsAction,
  type PlaylistDetailsCache,
  type PlaylistEntry,
  type PlaylistFollowAction,
  type PlaylistRemoveAction,
  type PlaylistReorderAction,
  type PlaylistReplaceAction,
  type PlaylistTrackAction,
  type PlaylistUnfollowAction,
  RETIRED_ACTION_PRUNE_INTERVAL_MS,
  RETIRED_ACTION_RETENTION_MS,
  type RemoveSavedAlbumsAction,
  type RemoveSavedTracksAction,
  SEARCH_FETCH_MAX,
  UnfollowArtistsAction,
  SPOTIFY_ACTIONS,
  type SaveAlbumsAction,
  type SaveTracksAction,
  type SpotifyAction,
  spotifyActionJournal,
  type StoredActionBody,
  type WithApi,
  applyPlaylistTrackOverlay,
  isPlaylistTrackAction,
  trackUriToId,
  trackUri,
  albumUri,
  artistUri,
  playlistUri,
} from "./spotify-actions";
import {
SpotifyAccountSessionImpl,
  SpotifyPlaylistImpl,
} from "./spotify-sessions";

@validateRpc()
export class SpotifyGatekeeperImpl extends DurableObject<Env, SpotifyGatekeeperImplProps>
  implements Gatekeeper<SpotifyAccountSession | SpotifyPlaylist> {

  #userAccount() {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  #withApi: WithApi = async <T>(fn: (api: SpotifyApi) => Promise<T>): Promise<T> => {
    const account = this.#userAccount();
    const api = new SpotifyApi(() => account.getAccessToken());
    try {
      return await fn(api);
    } catch (error) {
      if (error instanceof SpotifyApiError && error.isAuthError) {
        await account.notifyCredentialsExpired();
        throw new Error("Spotify credentials have expired or been revoked. Please reconnect the account.", { cause: error });
      }
      throw error;
    }
  };

  async describe(): Promise<ResourceDescription> {
    if (this.ctx.props.resourceKind === "playlist") {
      const playlistId = this.ctx.props.playlistId!;
      const playlist = await this.#withApi(api => api.getPlaylist(playlistId));
      const summary = normalizePlaylistSummary(playlist);
      return {
        url: summary.url,
        title: summary.name,
        snippet: summary.description?.trim() ||
          `Playlist by ${summary.owner.displayName ?? summary.owner.id} · ${summary.trackCount} tracks`,
        suggestedBindingName: "SPOTIFY_PLAYLIST",
        tsType: "SpotifyPlaylist",
      };
    }

    const user = await this.#withApi(api => api.getCurrentUser());
    return {
      url: externalUrl(user, profileUrl(user.id)),
      title: user.display_name ? `${user.display_name}'s Spotify` : "Spotify Account",
      snippet: "Whole-account access: library, playlists, search, and playback control.",
      suggestedBindingName: "SPOTIFY_ACCOUNT",
      tsType: "SpotifyAccountSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions() {
    // Derived from the set, so a kind newly marked auto-approvable is offered here without a
    // second list to keep in sync.
    return this.#actions.autoApprovableKinds();
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<SpotifyAccountSession | SpotifyPlaylist> {
    const queue = approvalQueue.dup();
    if (this.ctx.props.resourceKind === "playlist") {
      return new SpotifyPlaylistImpl(this, queue, this.ctx.props.playlistId!);
    }
    return new SpotifyAccountSessionImpl(this, queue);
  }

  /**
   * Observer tracking: Spotify uses the "low-stakes" strategy. A personal Spotify account (profile,
   * library, playlists, playback) is not the kind of restricted, access-controlled corporate data
   * the information-flow model exists to protect — if you share a Gadget that can read your
   * playlists, that is your call. So any collaborator may observe: addObserver/removeObserver are
   * no-ops and we never set excludeObservers on observations.
   */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}

  // -------------------------------------------------------------------------
  // Action storage & lookup

  // One per resource: ids for "~N" provisional playlists referenced before their create applies.
  #counter(name: string): number {
    const value = (this.ctx.storage.kv.get<number>(`counter:${name}`) ?? 0) + 1;
    this.ctx.storage.kv.put(`counter:${name}`, value);
    return value;
  }

  #newBase(): BaseAction {
    return { submittedAt: Date.now() };
  }

  #journal = spotifyActionJournal(this.ctx.storage.kv);

  // The engine-bound host: every provider operation an action kind's handlers run, resolved
  // against this resource's account, caches, and provisional bindings.
  #actions = SPOTIFY_ACTIONS.bind(this.#journal, {
    withApi: fn => this.#withApi(fn),
    requireRealPlaylistId: playlistId => this.#requireRealPlaylistId(playlistId),
    provisionalRealId: logicalId => this.#resolveRealPlaylistId(logicalId),
    playlistSummary: realId => this.#getPlaylistSummary(realId),
    materializePlaylist: realId => this.#materializePlaylistEntries(realId),
    applyAddTracks: (realId, uris, position) => this.#applyAddTracks(realId, uris, position),
    setPlaylistTracks: (realId, uris) => this.#setPlaylistTracks(realId, uris),
    invalidatePlaylist: realId => this.#invalidatePlaylist(realId),
    bindProvisional: (provisionalId, realId) => {
      this.ctx.storage.kv.put(this.#provisionalKey(provisionalId), { realId });
    },
    dropProvisional: provisionalId => { this.ctx.storage.kv.delete(this.#provisionalKey(provisionalId)); },
    pruneRetiredActions: () => this.#pruneRetiredActions(),
  });

  // Retained (applied) records are kept so the overseer can still revert recently-applied actions,
  // but they (and their revert snapshots, up to ~PLAYLIST_REVERT_SNAPSHOT_MAX URIs) must not
  // accumulate forever. Drop records submitted longer ago than the retention window; a record
  // approved very late is pruned from the submission date, which only shortens its revert window.
  // Rate-limited so we don't rescan the retained keyspace on every resolution.
  #pruneRetiredActions(): void {
    const last = this.ctx.storage.kv.get<number>("meta:lastRetiredPrune") ?? 0;
    if (Date.now() - last < RETIRED_ACTION_PRUNE_INTERVAL_MS) return;
    this.ctx.storage.kv.put("meta:lastRetiredPrune", Date.now());
    const cutoff = Date.now() - RETIRED_ACTION_RETENTION_MS;
    for (const [key, record] of this.ctx.storage.kv
      .list<{ v: number; action: { payload: { submittedAt?: number } } }>({ prefix: "retained:action:" })) {
      if ((record.action.payload.submittedAt ?? 0) < cutoff) this.ctx.storage.kv.delete(key);
    }
  }

  // Pending (and claimed, in-flight) actions, oldest first: the journal orders by id, which the
  // submission counter allocates in order.
  #listPending(): SpotifyAction[] {
    return this.#journal.listPending().map(({ action }) => action.payload);
  }

  #provisionalKey(provisionalId: string): string { return `provisional:${provisionalId}`; }

  // Resolve a logical playlist id (real, or a "~N" provisional) to its real Spotify id, or
  // undefined if it is a provisional playlist whose create action hasn't been applied yet.
  #resolveRealPlaylistId(logicalId: string): string | undefined {
    if (!logicalId.startsWith("~")) return logicalId;
    return this.ctx.storage.kv.get<{ realId: string }>(this.#provisionalKey(logicalId))?.realId;
  }

  // -------------------------------------------------------------------------
  // Playlist cache
  //
  // Only the (small) playlist summary is cached in KV. The full track list is never persisted —
  // it is materialized in memory on demand, and only when pending edits require simulating the
  // post-edit ordering. Reads with no pending edits fetch just the requested page directly. This
  // keeps KV values small regardless of playlist size.

  #playlistDetailsKey(realId: string): string { return `pldetails:${realId}`; }
  #invalidatePlaylist(realId: string): void { this.ctx.storage.kv.delete(this.#playlistDetailsKey(realId)); }

  async #getPlaylistSummary(realId: string): Promise<SpotifyPlaylistSummary> {
    const key = this.#playlistDetailsKey(realId);
    const cached = this.ctx.storage.kv.get<PlaylistDetailsCache>(key);
    if (cached && Date.now() - cached.fetchedAt < PLAYLIST_CACHE_TTL_MS) {
      return cached.summary;
    }
    let summary: SpotifyPlaylistSummary;
    try {
      summary = normalizePlaylistSummary(await this.#withApi(api => api.getPlaylist(realId)));
    } catch (error) {
      if (error instanceof SpotifyApiError && error.status === 404) {
        throw new Error(`No Spotify playlist found with id "${realId}".`, { cause: error });
      }
      throw error;
    }
    this.ctx.storage.kv.put<PlaylistDetailsCache>(key, { fetchedAt: Date.now(), summary });
    return summary;
  }

  #toPlaylistEntry(item: SpotifyPlaylistItemResponse): PlaylistEntry {
    const track = item.item ?? item.track ?? null;
    return {
      uri: track?.uri ?? "",
      track: track ? normalizeTrack(track) : null,
      addedAt: item.added_at ? new Date(item.added_at) : null,
      addedBy: item.added_by ? normalizeUserRef(item.added_by) : null,
    };
  }

  async #materializePlaylistEntries(realId: string): Promise<PlaylistEntry[]> {
    // Fetch the first page to learn the total, then fetch the remaining pages with bounded
    // concurrency (rather than one-at-a-time) to cut latency on large playlists.
    let first;
    try {
      first = await this.#withApi(api => api.listPlaylistItems(realId, 50, 0));
    } catch (error) {
      // Spotify withholds contents (403) for playlists the user doesn't own/collaborate on.
      if (error instanceof SpotifyApiError && error.status === 403) return [];
      throw error;
    }
    const entries = (first.items ?? []).map(item => this.#toPlaylistEntry(item));
    const total = Math.min(first.total ?? entries.length, PLAYLIST_MATERIALIZE_CAP);

    const offsets: number[] = [];
    for (let offset = 50; offset < total; offset += 50) offsets.push(offset);

    for (let i = 0; i < offsets.length; i += PLAYLIST_FETCH_CONCURRENCY) {
      const batch = offsets.slice(i, i + PLAYLIST_FETCH_CONCURRENCY);
      const pages = await Promise.all(
        batch.map(offset => this.#withApi(api => api.listPlaylistItems(realId, 50, offset))));
      for (const page of pages) {
        for (const item of page.items ?? []) entries.push(this.#toPlaylistEntry(item));
      }
    }
    return entries;
  }

  #pendingPlaylistTrackActions(logicalId: string): PlaylistTrackAction[] {
    return this.#listPending().filter(
      (a): a is PlaylistTrackAction => isPlaylistTrackAction(a) && a.playlistId === logicalId);
  }

  // Full effective (overlaid) track list for a playlist. Only call when simulation is needed
  // (pending track edits exist, or the playlist is provisional).
  async #effectivePlaylistEntries(logicalId: string, realId: string | undefined): Promise<PlaylistEntry[]> {
    let entries = realId ? await this.#materializePlaylistEntries(realId) : [];
    const trackActions = this.#pendingPlaylistTrackActions(logicalId);
    if (trackActions.length > 0) {
      const uris = new Set<string>();
      for (const action of trackActions) {
        if (action.type === "playlistAdd" || action.type === "playlistReplace") {
          for (const uri of action.uris) uris.add(uri);
        }
      }
      const meta = await this.#resolveTrackMetaByUri(uris);
      for (const action of trackActions) entries = applyPlaylistTrackOverlay(entries, action, meta);
    }
    return entries;
  }

  /**
   * Verify the connected user may edit this playlist (owns it, or it's collaborative) before
   * queueing a content edit, and return the current (simulated) track count for bounds checks.
   * Provisional (not-yet-created) playlists are always owned by the user.
   */
  async assertEditablePlaylist(logicalId: string): Promise<{ trackCount: number }> {
    const realId = this.#resolveRealPlaylistId(logicalId);
    if (!realId) {
      return { trackCount: (await this.#effectivePlaylistEntries(logicalId, undefined)).length };
    }
    const [summary, me] = await Promise.all([this.#getPlaylistSummary(realId), this.#currentUserRef()]);
    if (summary.owner.id !== me.id && !summary.collaborative) {
      throw new Error(
        `Cannot edit playlist "${summary.name}": it is owned by ` +
        `${summary.owner.displayName ?? summary.owner.id} and is not collaborative.`);
    }
    const pendingDelta = this.#pendingPlaylistTrackActions(logicalId).length > 0
      ? (await this.#effectivePlaylistEntries(logicalId, realId)).length
      : summary.trackCount;
    return { trackCount: pendingDelta };
  }

  #playlistCountKey(realId: string): string { return `plcount:${realId}`; }

  async #resolveTrackMetaByUri(uris: Iterable<string>): Promise<Map<string, SpotifyTrack>> {
    const meta = new Map<string, SpotifyTrack>();
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const uri of uris) {
      const id = trackUriToId(uri);
      if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
    }
    for (let i = 0; i < ids.length; i += METADATA_CHUNK) {
      const tracks = await this.#withApi(api => api.getTracks(ids.slice(i, i + METADATA_CHUNK)));
      for (const track of tracks) if (track) meta.set(track.uri, normalizeTrack(track));
    }
    return meta;
  }

  async #resolveTracksById(ids: string[]): Promise<Map<string, SpotifyTrack>> {
    const meta = new Map<string, SpotifyTrack>();
    for (let i = 0; i < ids.length; i += METADATA_CHUNK) {
      const tracks = await this.#withApi(api => api.getTracks(ids.slice(i, i + METADATA_CHUNK)));
      for (const track of tracks) if (track) meta.set(track.id, normalizeTrack(track));
    }
    return meta;
  }

  async #resolveAlbumsById(ids: string[]): Promise<Map<string, SpotifyAlbumRef>> {
    const meta = new Map<string, SpotifyAlbumRef>();
    for (let i = 0; i < ids.length; i += METADATA_CHUNK) {
      const albums = await this.#withApi(api => api.getAlbums(ids.slice(i, i + METADATA_CHUNK)));
      for (const album of albums) if (album) meta.set(album.id, normalizeAlbumRef(album));
    }
    return meta;
  }

  // -------------------------------------------------------------------------
  // Reads (with simulation overlay)

  #cachedUserRef?: SpotifyUserRef;
  async #currentUserRef(): Promise<SpotifyUserRef> {
    if (!this.#cachedUserRef) {
      this.#cachedUserRef = normalizeUserRef(await this.#withApi(api => api.getCurrentUser()));
    }
    return this.#cachedUserRef;
  }

  async getProfile(): Promise<SpotifyProfile> {
    return normalizeProfile(await this.#withApi(api => api.getCurrentUser()));
  }

  async search(query: string, types: SpotifySearchType[], limit?: number): Promise<SpotifySearchResults> {
    // Feb 2026 reduced the search limit maximum from 50 to 10 for development-mode apps.
    const count = clampLimit(limit, 10, 10);
    // Spotify sprinkles `null` placeholders into playlist search results, which we drop — so a
    // small limit can filter down to fewer (even zero) items. Over-fetch to the API max and then
    // slice each category to the requested count to backfill those gaps.
    const result = await this.#withApi(api => api.search(query, types, SEARCH_FETCH_MAX));
    return {
      tracks: (result.tracks?.items ?? []).filter(Boolean).map(normalizeTrack).slice(0, count),
      artists: (result.artists?.items ?? []).filter(Boolean).map(normalizeArtistRef).slice(0, count),
      albums: (result.albums?.items ?? []).filter(Boolean).map(normalizeAlbumRef).slice(0, count),
      playlists: (result.playlists?.items ?? []).filter(Boolean).map(normalizePlaylistSummary).slice(0, count),
    };
  }

  async getTrack(trackId: string): Promise<SpotifyTrack> {
    try {
      return normalizeTrack(await this.#withApi(api => api.getTrack(trackId)));
    } catch (error) {
      if (error instanceof SpotifyApiError && (error.status === 404 || error.status === 400)) {
        throw new Error(`No Spotify track found with id "${trackId}".`, { cause: error });
      }
      throw error;
    }
  }

  async getTopTracks(timeRange: SpotifyTopTimeRange | undefined, limit?: number): Promise<SpotifyTrack[]> {
    const result = await this.#withApi(api => api.getTopTracks(normalizeTimeRange(timeRange), clampLimit(limit, 20, 50)));
    return (result.items ?? []).map(normalizeTrack);
  }

  async getTopArtists(timeRange: SpotifyTopTimeRange | undefined, limit?: number): Promise<SpotifyArtistRef[]> {
    const result = await this.#withApi(api => api.getTopArtists(normalizeTimeRange(timeRange), clampLimit(limit, 20, 50)));
    return (result.items ?? []).map(normalizeArtistRef);
  }

  #pendingSavedDelta(kind: "track" | "album"): { added: string[]; removed: Set<string> } {
    const added: string[] = [];
    const removed = new Set<string>();
    const add = (ids: string[]) => {
      for (const id of ids) { removed.delete(id); if (!added.includes(id)) added.push(id); }
    };
    const remove = (ids: string[]) => {
      for (const id of ids) { const i = added.indexOf(id); if (i >= 0) added.splice(i, 1); removed.add(id); }
    };
    for (const action of this.#listPending()) {
      if (kind === "track") {
        if (action.type === "saveTracks") add(action.trackIds);
        else if (action.type === "removeSavedTracks") remove(action.trackIds);
      } else {
        if (action.type === "saveAlbums") add(action.albumIds);
        else if (action.type === "removeSavedAlbums") remove(action.albumIds);
      }
    }
    return { added, removed };
  }

  async areTracksSaved(trackIds: string[]): Promise<boolean[]> {
    if (trackIds.length === 0) return [];
    const base = await this.#withApi(api => api.libraryContains(trackIds.map(trackUri)));
    const pending = this.#listPending();
    return trackIds.map((id, i) => {
      let saved = base[i] ?? false;
      for (const action of pending) {
        if (action.type === "saveTracks" && action.trackIds.includes(id)) saved = true;
        else if (action.type === "removeSavedTracks" && action.trackIds.includes(id)) saved = false;
      }
      return saved;
    });
  }

  async areArtistsFollowed(artistIds: string[]): Promise<boolean[]> {
    if (artistIds.length === 0) return [];
    const base = await this.#withApi(api => api.libraryContains(artistIds.map(artistUri)));
    const pending = this.#listPending();
    return artistIds.map((id, i) => {
      let following = base[i] ?? false;
      for (const action of pending) {
        if (action.type === "followArtists" && action.artistIds.includes(id)) following = true;
        else if (action.type === "unfollowArtists" && action.artistIds.includes(id)) following = false;
      }
      return following;
    });
  }

  async areAlbumsSaved(albumIds: string[]): Promise<boolean[]> {
    if (albumIds.length === 0) return [];
    const base = await this.#withApi(api => api.libraryContains(albumIds.map(albumUri)));
    const pending = this.#listPending();
    return albumIds.map((id, i) => {
      let saved = base[i] ?? false;
      for (const action of pending) {
        if (action.type === "saveAlbums" && action.albumIds.includes(id)) saved = true;
        else if (action.type === "removeSavedAlbums" && action.albumIds.includes(id)) saved = false;
      }
      return saved;
    });
  }

  async isFollowingPlaylist(logicalId: string): Promise<boolean> {
    const realId = this.#resolveRealPlaylistId(logicalId);
    // A provisional (pending-create) playlist will land in the user's library once approved.
    let following = realId
      ? (await this.#withApi(api => api.libraryContains([playlistUri(realId)])))[0] ?? false
      : true;
    for (const action of this.#listPending()) {
      if (action.type === "playlistFollow" && action.playlistId === logicalId) following = true;
      else if (action.type === "playlistUnfollow" && action.playlistId === logicalId) following = false;
    }
    return following;
  }

  async listSavedTracks(limit?: number, offset?: number): Promise<SpotifyTrack[]> {
    const lim = clampLimit(limit, 20, 50);
    const off = clampOffset(offset);
    const base = await this.#withApi(api => api.listSavedTracks(lim, off));
    let tracks = (base.items ?? []).map(item => normalizeTrack(item.track));
    const { added, removed } = this.#pendingSavedDelta("track");
    if (removed.size > 0) tracks = tracks.filter(track => !removed.has(track.id));
    if (off === 0 && added.length > 0) {
      const meta = await this.#resolveTracksById(added);
      const existing = new Set(tracks.map(track => track.id));
      const prepend = added.slice().toReversed()
        .map(id => meta.get(id))
        .filter((track): track is SpotifyTrack => !!track && !existing.has(track.id));
      tracks = [...prepend, ...tracks];
    }
    return tracks.slice(0, lim);
  }

  async listSavedAlbums(limit?: number, offset?: number): Promise<SpotifyAlbumRef[]> {
    const lim = clampLimit(limit, 20, 50);
    const off = clampOffset(offset);
    const base = await this.#withApi(api => api.listSavedAlbums(lim, off));
    let albums = (base.items ?? []).map(item => normalizeAlbumRef(item.album));
    const { added, removed } = this.#pendingSavedDelta("album");
    if (removed.size > 0) albums = albums.filter(album => !removed.has(album.id));
    if (off === 0 && added.length > 0) {
      const meta = await this.#resolveAlbumsById(added);
      const existing = new Set(albums.map(album => album.id));
      const prepend = added.slice().toReversed()
        .map(id => meta.get(id))
        .filter((album): album is SpotifyAlbumRef => !!album && !existing.has(album.id));
      albums = [...prepend, ...albums];
    }
    return albums.slice(0, lim);
  }

  #synthCreatedSummary(create: PlaylistCreateAction): SpotifyPlaylistSummary {
    const trackCount = this.#listPending()
      .filter((a): a is PlaylistAddAction => a.type === "playlistAdd" && a.playlistId === create.provisionalId)
      .reduce((total, a) => total + a.uris.length, 0);
    return {
      id: create.provisionalId,
      name: create.name,
      uri: `spotify:playlist:${create.provisionalId}`,
      url: playlistUrl(create.provisionalId),
      description: create.description ?? null,
      owner: { id: "", displayName: null, uri: "", url: "" },
      public: create.public ?? null,
      collaborative: create.collaborative ?? false,
      trackCount,
      images: [],
      snapshotId: "",
    };
  }

  async listPlaylists(limit?: number, offset?: number): Promise<SpotifyPlaylistSummary[]> {
    const lim = clampLimit(limit, 20, 50);
    const off = clampOffset(offset);
    const base = await this.#withApi(api => api.listMyPlaylists(lim, off));
    let summaries = (base.items ?? []).filter(Boolean).map(normalizePlaylistSummary);
    // Remember each playlist's real track count. GET /playlists/{id} withholds it for playlists the
    // user doesn't own, so getDetails() uses this as a fallback to stay consistent with listPlaylists.
    for (const summary of summaries) {
      this.ctx.storage.kv.put(this.#playlistCountKey(summary.id), summary.trackCount);
    }
    // Simulate pending unfollows: a playlist queued for removal disappears from the library view.
    // (This filters after fetching `lim`, so a page can return fewer than `lim` items when removals
    // are pending — acceptable for a simulated view; callers paginate via offset.)
    const unfollowed = new Set(
      this.#listPending()
        .filter((a): a is PlaylistUnfollowAction => a.type === "playlistUnfollow")
        .map(a => a.playlistId));
    if (unfollowed.size > 0) summaries = summaries.filter(summary => !unfollowed.has(summary.id));
    if (off !== 0) return summaries;
    const creates = this.#listPending().filter((a): a is PlaylistCreateAction => a.type === "playlistCreate");
    if (creates.length === 0) return summaries;
    // Surface pending (unapproved) creates at the top, with a simulated track count that reflects
    // all queued edits on the provisional playlist (not just the initial adds).
    const owner = await this.#currentUserRef();
    const synth: SpotifyPlaylistSummary[] = [];
    for (const create of creates) {
      const summary = this.#applyDetailsOverlay(create.provisionalId, this.#synthCreatedSummary(create));
      const entries = await this.#effectivePlaylistEntries(create.provisionalId, undefined);
      synth.push({ ...summary, owner, trackCount: entries.length });
    }
    synth.reverse();
    // Prepend pending creates on the first page WITHOUT slicing — slicing here would silently drop
    // the tail real playlists (they'd never reappear, since page 2 starts at real offset = lim).
    // The first page may therefore return up to `synth.length` items beyond `lim`.
    return [...synth, ...summaries];
  }

  #applyDetailsOverlay(logicalId: string, summary: SpotifyPlaylistSummary): SpotifyPlaylistSummary {
    let { name, description, public: isPublic, collaborative } = summary;
    for (const action of this.#listPending()) {
      if (action.type === "playlistDetails" && action.playlistId === logicalId) {
        if (action.update.name !== undefined) name = action.update.name;
        if (action.update.description !== undefined) description = action.update.description;
        if (action.update.public !== undefined) isPublic = action.update.public;
        if (action.update.collaborative !== undefined) collaborative = action.update.collaborative;
      }
    }
    return { ...summary, name, description, public: isPublic, collaborative };
  }

  async playlistGetDetails(logicalId: string): Promise<SpotifyPlaylistSummary> {
    const realId = this.#resolveRealPlaylistId(logicalId);
    const hasTrackEdits = this.#pendingPlaylistTrackActions(logicalId).length > 0;

    let summary: SpotifyPlaylistSummary;
    if (realId) {
      summary = this.#applyDetailsOverlay(logicalId, await this.#getPlaylistSummary(realId));
      if (hasTrackEdits) {
        summary = { ...summary, trackCount: (await this.#effectivePlaylistEntries(logicalId, realId)).length };
      } else if (summary.trackCount === 0) {
        // Spotify withholds the count for non-owned playlists here; fall back to a count we saw via
        // listPlaylists so the two reads agree.
        const cached = this.ctx.storage.kv.get<number>(this.#playlistCountKey(realId));
        if (cached) summary = { ...summary, trackCount: cached };
      }
    } else {
      const create = this.#listPending().find(
        (a): a is PlaylistCreateAction => a.type === "playlistCreate" && a.provisionalId === logicalId);
      if (!create) throw new Error(`Spotify playlist ${logicalId} was not found.`);
      summary = this.#applyDetailsOverlay(logicalId, this.#synthCreatedSummary(create));
      summary = {
        ...summary,
        owner: await this.#currentUserRef(),
        trackCount: (await this.#effectivePlaylistEntries(logicalId, undefined)).length,
      };
    }
    return summary;
  }

  async playlistListTracks(logicalId: string, limit?: number, offset?: number): Promise<SpotifyPlaylistTrack[]> {
    const lim = clampLimit(limit, 50, 50);
    const off = clampOffset(offset);
    const realId = this.#resolveRealPlaylistId(logicalId);

    // Fast path: a real playlist with no pending track edits needs no simulation, so read just the
    // requested page directly rather than materializing the whole list.
    if (realId && this.#pendingPlaylistTrackActions(logicalId).length === 0) {
      let page;
      try {
        page = await this.#withApi(api => api.listPlaylistItems(realId, lim, off));
      } catch (error) {
        // Non-owned playlists: Spotify withholds contents (403). Match the documented empty result.
        if (error instanceof SpotifyApiError && error.status === 403) return [];
        throw error;
      }
      return (page.items ?? []).map((item, index) => {
        const track = item.item ?? item.track ?? null;
        return {
          position: off + index,
          addedAt: item.added_at ? new Date(item.added_at) : null,
          addedBy: item.added_by ? normalizeUserRef(item.added_by) : null,
          track: track ? normalizeTrack(track) : null,
        };
      });
    }

    if (!realId) {
      const create = this.#listPending().find(
        (a): a is PlaylistCreateAction => a.type === "playlistCreate" && a.provisionalId === logicalId);
      if (!create) throw new Error(`Spotify playlist ${logicalId} was not found.`);
    }

    const entries = await this.#effectivePlaylistEntries(logicalId, realId);
    return entries.slice(off, off + lim).map((entry, index) => ({
      position: off + index,
      addedAt: entry.addedAt,
      addedBy: entry.addedBy,
      track: entry.track,
    }));
  }

  async playerGetState(): Promise<SpotifyPlaybackState> {
    return normalizePlaybackState(await this.#withApi(api => api.getPlaybackState()));
  }

  async playerGetDevices(): Promise<SpotifyDevice[]> {
    return (await this.#withApi(api => api.getDevices())).map(normalizeDevice);
  }

  async playerGetQueue(): Promise<{ currentlyPlaying: SpotifyTrack | null; queue: SpotifyTrack[] }> {
    const result = await this.#withApi(api => api.getQueue());
    if (!result) return { currentlyPlaying: null, queue: [] };
    return {
      currentlyPlaying: result.currently_playing ? normalizeTrack(result.currently_playing) : null,
      queue: (result.queue ?? []).map(normalizeTrack),
    };
  }

  async playerGetRecentlyPlayed(limit?: number): Promise<SpotifyPlayHistoryEntry[]> {
    const result = await this.#withApi(api => api.getRecentlyPlayed(clampLimit(limit, 20, 50)));
    return (result.items ?? []).map(item => ({
      track: normalizeTrack(item.track),
      playedAt: new Date(item.played_at),
      contextUri: item.context?.uri ?? null,
    }));
  }

  // -------------------------------------------------------------------------
  // Action preparation + submission

  prepareSaveTracks(trackIds: string[]): SaveTracksAction { return { ...this.#newBase(), type: "saveTracks", trackIds }; }
  prepareRemoveSavedTracks(trackIds: string[]): RemoveSavedTracksAction { return { ...this.#newBase(), type: "removeSavedTracks", trackIds }; }
  prepareSaveAlbums(albumIds: string[]): SaveAlbumsAction { return { ...this.#newBase(), type: "saveAlbums", albumIds }; }
  prepareRemoveSavedAlbums(albumIds: string[]): RemoveSavedAlbumsAction { return { ...this.#newBase(), type: "removeSavedAlbums", albumIds }; }
  prepareFollowArtists(artistIds: string[]): FollowArtistsAction { return { ...this.#newBase(), type: "followArtists", artistIds }; }
  prepareUnfollowArtists(artistIds: string[]): UnfollowArtistsAction { return { ...this.#newBase(), type: "unfollowArtists", artistIds }; }

  preparePlaylistCreate(
    name: string,
    options?: { description?: string; public?: boolean; collaborative?: boolean },
  ): PlaylistCreateAction {
    return {
      ...this.#newBase(),
      type: "playlistCreate",
      provisionalId: `~${this.#counter("provisional")}`,
      name,
      description: options?.description,
      // Spotify makes a playlist public unless told otherwise, and a collaborative one must be
      // private, so an omitted `public` is resolved here rather than left to the API.
      public: options?.public ?? !options?.collaborative,
      collaborative: options?.collaborative,
    };
  }

  preparePlaylistAdd(playlistId: string, uris: string[], position?: number): PlaylistAddAction {
    return { ...this.#newBase(), type: "playlistAdd", playlistId, uris, position };
  }
  preparePlaylistRemove(playlistId: string, uris: string[]): PlaylistRemoveAction {
    return { ...this.#newBase(), type: "playlistRemove", playlistId, uris };
  }
  preparePlaylistReorder(playlistId: string, rangeStart: number, insertBefore: number, rangeLength: number): PlaylistReorderAction {
    return { ...this.#newBase(), type: "playlistReorder", playlistId, rangeStart, insertBefore, rangeLength };
  }
  preparePlaylistReplace(playlistId: string, uris: string[]): PlaylistReplaceAction {
    return { ...this.#newBase(), type: "playlistReplace", playlistId, uris };
  }
  preparePlaylistDetails(playlistId: string, update: SpotifyPlaylistDetailsUpdate): PlaylistDetailsAction {
    return { ...this.#newBase(), type: "playlistDetails", playlistId, update };
  }
  preparePlaylistUnfollow(playlistId: string): PlaylistUnfollowAction {
    return { ...this.#newBase(), type: "playlistUnfollow", playlistId };
  }
  preparePlaylistFollow(playlistId: string): PlaylistFollowAction {
    return { ...this.#newBase(), type: "playlistFollow", playlistId };
  }
  preparePlayer(command: PlayerCommand): PlayerAction {
    return { ...this.#newBase(), type: "player", command };
  }

  async submitActionForApproval(queue: RpcStub<ApprovalQueue>, action: SpotifyAction): Promise<void> {
    // Description, id allocation, staging, and rollback all belong to the engine; the approval
    // text is rendered from the payload it will apply.
    await this.#actions.submit(queue, action.type, action);
  }

  // -------------------------------------------------------------------------
  // Action lifecycle (apply / reject / revert)

  async #applyAddTracks(realId: string, uris: string[], position?: number): Promise<void> {
    let pos = position;
    for (let i = 0; i < uris.length; i += PLAYLIST_WRITE_CHUNK) {
      const chunk = uris.slice(i, i + PLAYLIST_WRITE_CHUNK);
      await this.#withApi(api => api.addPlaylistItems(realId, chunk, pos));
      if (pos !== undefined) pos += chunk.length;
    }
  }

  async #setPlaylistTracks(realId: string, uris: string[]): Promise<void> {
    await this.#withApi(api => api.replacePlaylistItems(realId, uris.slice(0, PLAYLIST_WRITE_CHUNK)));
    for (let i = PLAYLIST_WRITE_CHUNK; i < uris.length; i += PLAYLIST_WRITE_CHUNK) {
      await this.#withApi(api => api.addPlaylistItems(realId, uris.slice(i, i + PLAYLIST_WRITE_CHUNK)));
    }
  }

  // The player kind's apply handler dispatches a command itself (see `applyPlayerCommand`).

  // Resolve a (possibly provisional) playlist id to its real id at apply time. A dependent action
  // on a provisional playlist (e.g. add tracks to a just-created playlist) can only be applied
  // after the create action has been applied. The overseer applies one action at a time and may do
  // so out of submission order; if a dependent is applied first this throws, and the user can retry
  // after approving the create. rejectAction() of a create cascades a rejection to its dependents.
  #requireRealPlaylistId(playlistId: string): string {
    const realId = this.#resolveRealPlaylistId(playlistId);
    if (!realId) {
      throw new Error(`Playlist ${playlistId} has not been created on Spotify yet. Approve the playlist creation first.`);
    }
    return realId;
  }

  /**
   * Claim-before-dispatch, retry on a plain provider error, and the terminal unknown outcome all
   * belong to the engine; see `SPOTIFY_ACTIONS` for the per-kind behavior.
   */
  async applyAction(actionId: number): Promise<void> {
    await this.#actions.apply(actionId);
  }

  async rejectAction(actionId: number): Promise<void | { restart?: boolean }> {
    // The engine is lenient on an unknown id (a stale queue entry can always be cleared), strands
    // dependents of a rejected provisional create, and releases the provisional binding. Rejecting
    // a create must also restart sessions: their simulated view still shows the playlist.
    const kind = this.#journal.get(actionId)?.action.kind;
    await this.#actions.reject(actionId);
    return kind === "playlistCreate" ? { restart: true } : undefined;
  }

  async revertAction(actionId: number): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    const record = this.#journal.get(actionId);
    if (record === undefined) throw new Error(`No queued Spotify action exists with id ${actionId}.`);
    if (record.state !== "applied") {
      return { message: "This action has not been applied, so there is nothing to revert.", canRetry: false };
    }
    // The retained payload is the applied write plus the snapshot its apply retained for revert.
    const action = record.action.payload as StoredActionBody;
    const revert = action.revert;
    switch (action.type) {
      case "saveTracks": await this.#withApi(api => api.removeFromLibrary(action.trackIds.map(trackUri))); return;
      case "removeSavedTracks": await this.#withApi(api => api.saveToLibrary(action.trackIds.map(trackUri))); return;
      case "saveAlbums": await this.#withApi(api => api.removeFromLibrary(action.albumIds.map(albumUri))); return;
      case "removeSavedAlbums": await this.#withApi(api => api.saveToLibrary(action.albumIds.map(albumUri))); return;
      case "followArtists": await this.#withApi(api => api.removeFromLibrary(action.artistIds.map(artistUri))); return;
      case "unfollowArtists": await this.#withApi(api => api.saveToLibrary(action.artistIds.map(artistUri))); return;
      case "playlistUnfollow": {
        const realId = this.#resolveRealPlaylistId(action.playlistId);
        if (!realId) return { message: "This playlist no longer exists.", canRetry: false };
        // Re-add (re-follow) the playlist to the user's library.
        await this.#withApi(api => api.saveToLibrary([playlistUri(realId)]));
        return;
      }
      case "playlistFollow": {
        const realId = this.#resolveRealPlaylistId(action.playlistId);
        if (!realId) return { message: "This playlist no longer exists.", canRetry: false };
        await this.#withApi(api => api.removeFromLibrary([playlistUri(realId)]));
        return;
      }
      case "playlistCreate": {
        if (revert?.kind !== "playlistCreate") {
          return { message: "This playlist was never created, so there is nothing to revert.", canRetry: false };
        }
        const realId = revert.realId;
        // "Deleting" a playlist on Spotify means unfollowing it (removing it from your library).
        await this.#withApi(api => api.removeFromLibrary([playlistUri(realId)]));
        return;
      }
      case "playlistAdd":
      case "playlistRemove":
      case "playlistReorder":
      case "playlistReplace": {
        if (revert?.kind !== "playlistTracks") {
          return {
            message: "This playlist was too large to snapshot, so it can't be reverted automatically. " +
              "Please restore it manually.",
            canRetry: false,
          };
        }
        await this.#setPlaylistTracks(revert.realId, revert.previousUris);
        this.#invalidatePlaylist(revert.realId);
        return;
      }
      case "playlistDetails": {
        if (revert?.kind !== "playlistDetails") {
          return { message: "Revert information is unavailable for this action.", canRetry: false };
        }
        const { realId, previous } = revert;
        await this.#withApi(api => api.changePlaylistDetails(realId, previous));
        this.#invalidatePlaylist(realId);
        return;
      }
      case "player":
        return { message: "Playback actions cannot be reverted.", canRetry: false };
    }
  }
}
