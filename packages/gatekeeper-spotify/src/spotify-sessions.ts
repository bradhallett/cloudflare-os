// Session implementations: the per-binding RPC surfaces (player, playlist, account) the
// gatekeeper hands to the sandbox. They call back into SpotifyGatekeeperImpl for every
// provider operation, so credentials and caches stay in the DO.

import {
  RpcStub,
  RpcTarget,
} from "cloudflare:workers";
import {
  validateRpc,
  skipRpcValidation,
} from "capnweb-validate";
import { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import {
  type SpotifyAccountSession,
  type SpotifyAlbumRef,
  type SpotifyArtistRef,
  type SpotifyDevice,
  type SpotifyPlaybackState,
  type SpotifyPlayHistoryEntry,
  type SpotifyPlayer,
  type SpotifyPlaylist,
  type SpotifyPlaylistSummary,
  type SpotifyPlaylistTrack,
  type SpotifyPlayOptions,
  type SpotifyProfile,
  type SpotifyRepeatMode,
  type SpotifySearchResults,
  type SpotifySearchType,
  type SpotifyTopTimeRange,
  type SpotifyTrack,
  type SpotifyPlaylistDetailsUpdate,
} from "./types";

import type { SpotifyGatekeeperImpl } from "./spotify-gatekeeper";
import {
MAX_PLAYLIST_URIS_PER_CALL,
  type PlayerCommand,
  REPEAT_MODES,
  SEARCH_TYPES,
  TOP_TIME_RANGES,
  assertOptionalDeviceId,
  assertOptionalLimit,
  toBareId,
  toContextUri,
  toPlaylistLogicalId,
  toTrackUri,
} from "./spotify-actions";

// ---------------------------------------------------------------------------
// Session implementations

function disposeQueue(queue: RpcStub<ApprovalQueue>): void {
  (queue as RpcStub<ApprovalQueue> & { [Symbol.dispose](): void })[Symbol.dispose]();
}

@validateRpc()
export class SpotifyPlayerImpl extends RpcTarget implements SpotifyPlayer {
  #gk: SpotifyGatekeeperImpl;
  #queue: RpcStub<ApprovalQueue>;

  constructor(gk: SpotifyGatekeeperImpl, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#gk = gk;
    this.#queue = queue;
  }

  [Symbol.dispose](): void {
    disposeQueue(this.#queue);
  }

  async #submit(command: PlayerCommand): Promise<void> {
    const action = this.#gk.preparePlayer(command);
    await this.#gk.submitActionForApproval(this.#queue, action);
  }

  async getState(): Promise<SpotifyPlaybackState> {
    const state = await this.#gk.playerGetState();
    await this.#queue.authorizeObservation({
      title: "Read playback state",
      description: "Read the current Spotify playback state and active device.",
    });
    return state;
  }

  async getDevices(): Promise<SpotifyDevice[]> {
    const devices = await this.#gk.playerGetDevices();
    await this.#queue.authorizeObservation({
      title: "List playback devices",
      description: "List the available Spotify Connect devices.",
    });
    return devices;
  }

  async getQueue(): Promise<{ currentlyPlaying: SpotifyTrack | null; queue: SpotifyTrack[] }> {
    const result = await this.#gk.playerGetQueue();
    await this.#queue.authorizeObservation({
      title: "Read playback queue",
      description: "Read the currently playing track and the upcoming playback queue.",
    });
    return result;
  }

  async getRecentlyPlayed(limit?: number): Promise<SpotifyPlayHistoryEntry[]> {
    const result = await this.#gk.playerGetRecentlyPlayed(limit);
    await this.#queue.authorizeObservation({
      title: "Read recently played",
      description: "Read recently played tracks from listening history.",
    });
    return result;
  }

  async play(options?: SpotifyPlayOptions): Promise<void> {
    if (options?.contextUri && options?.trackUris) {
      throw new Error("play(): provide either contextUri or trackUris, not both.");
    }
    const body: Record<string, unknown> = {};
    if (options?.contextUri) body.context_uri = toContextUri(options.contextUri);
    if (options?.trackUris) body.uris = options.trackUris.map(toTrackUri);
    if (options?.offsetPosition !== undefined) body.offset = { position: options.offsetPosition };
    if (options?.positionMs !== undefined) body.position_ms = options.positionMs;
    await this.#submit({ op: "play", deviceId: options?.deviceId, body });
  }

  async pause(deviceId?: string): Promise<void> {
    await this.#submit({ op: "pause", deviceId });
  }

  async next(deviceId?: string): Promise<void> {
    await this.#submit({ op: "next", deviceId });
  }

  async previous(deviceId?: string): Promise<void> {
    await this.#submit({ op: "previous", deviceId });
  }

  async seek(positionMs: number, deviceId?: string): Promise<void> {
    if (!Number.isFinite(positionMs) || positionMs < 0) {
      throw new Error("seek(): positionMs must be a non-negative number of milliseconds.");
    }
    const pos = Math.floor(positionMs);
    await this.#submit({ op: "seek", positionMs: pos, deviceId });
  }

  async setVolume(volumePercent: number, deviceId?: string): Promise<void> {
    if (!Number.isFinite(volumePercent) || volumePercent < 0 || volumePercent > 100) {
      throw new Error("setVolume(): volumePercent must be between 0 and 100.");
    }
    const volume = Math.round(volumePercent);
    await this.#submit({ op: "setVolume", volumePercent: volume, deviceId });
  }

  @skipRpcValidation()
  async setShuffle(shuffle: boolean, deviceId?: string): Promise<void> {
    if (typeof shuffle !== "boolean") {
      throw new Error("setShuffle(): shuffle must be a boolean (true or false).");
    }
    assertOptionalDeviceId(deviceId);
    await this.#submit({ op: "setShuffle", shuffle, deviceId });
  }

  @skipRpcValidation()
  async setRepeat(mode: string, deviceId?: string): Promise<void> {
    if (typeof mode !== "string" || !REPEAT_MODES.has(mode)) {
      throw new Error(`setRepeat(): mode must be one of "off", "track", or "context".`);
    }
    assertOptionalDeviceId(deviceId);
    await this.#submit({ op: "setRepeat", mode: mode as SpotifyRepeatMode, deviceId });
  }

  async transferTo(deviceId: string, play?: boolean): Promise<void> {
    if (typeof deviceId !== "string" || deviceId.trim() === "") {
      throw new Error("transferTo(): deviceId must be a non-empty string.");
    }
    await this.#submit({ op: "transfer", deviceId, play: play ?? false });
  }

  async addToQueue(uri: string, deviceId?: string): Promise<void> {
    const trackUriValue = toTrackUri(uri);
    await this.#submit({ op: "addToQueue", uri: trackUriValue, deviceId });
  }
}

@validateRpc()
export class SpotifyPlaylistImpl extends RpcTarget implements SpotifyPlaylist {
  #gk: SpotifyGatekeeperImpl;
  #queue: RpcStub<ApprovalQueue>;
  #logicalId: string;

  constructor(gk: SpotifyGatekeeperImpl, queue: RpcStub<ApprovalQueue>, logicalId: string) {
    super();
    this.#gk = gk;
    this.#queue = queue;
    this.#logicalId = logicalId;
  }

  [Symbol.dispose](): void {
    disposeQueue(this.#queue);
  }

  async getDetails(): Promise<SpotifyPlaylistSummary> {
    const summary = await this.#gk.playlistGetDetails(this.#logicalId);
    await this.#queue.authorizeObservation({
      title: `Read playlist "${summary.name}"`,
      description: `Read details of the Spotify playlist "${summary.name}" (${summary.trackCount} tracks).`,
    });
    return summary;
  }

  async listTracks(limit?: number, offset?: number): Promise<SpotifyPlaylistTrack[]> {
    const tracks = await this.#gk.playlistListTracks(this.#logicalId, limit, offset);
    await this.#queue.authorizeObservation({
      title: "Read playlist tracks",
      description: `Read ${tracks.length} track(s) from the playlist.`,
    });
    return tracks;
  }

  async addTracks(trackUris: string[], position?: number): Promise<void> {
    if (trackUris.length === 0) return;
    if (trackUris.length > MAX_PLAYLIST_URIS_PER_CALL) {
      throw new Error(`addTracks(): at most ${MAX_PLAYLIST_URIS_PER_CALL} URIs per call.`);
    }
    if (position !== undefined && (!Number.isInteger(position) || position < 0)) {
      throw new Error("addTracks(): position must be a non-negative integer.");
    }
    const uris = trackUris.map(toTrackUri);
    await this.#gk.assertEditablePlaylist(this.#logicalId);
    const action = this.#gk.preparePlaylistAdd(this.#logicalId, uris, position);
    await this.#gk.submitActionForApproval(this.#queue, action);
  }

  async removeTracks(trackUris: string[]): Promise<void> {
    if (trackUris.length === 0) return;
    const uris = trackUris.map(toTrackUri);
    await this.#gk.assertEditablePlaylist(this.#logicalId);
    const action = this.#gk.preparePlaylistRemove(this.#logicalId, uris);
    await this.#gk.submitActionForApproval(this.#queue, action);
  }

  async reorderTracks(rangeStart: number, insertBefore: number, rangeLength?: number): Promise<void> {
    const length = rangeLength ?? 1;
    if (!Number.isInteger(rangeStart) || rangeStart < 0 ||
        !Number.isInteger(insertBefore) || insertBefore < 0 ||
        !Number.isInteger(length) || length < 1) {
      throw new Error("reorderTracks(): rangeStart/insertBefore must be >= 0 and rangeLength >= 1.");
    }
    const { trackCount } = await this.#gk.assertEditablePlaylist(this.#logicalId);
    if (rangeStart + length > trackCount || insertBefore > trackCount) {
      throw new Error(`reorderTracks(): range is out of bounds for a playlist with ${trackCount} track(s).`);
    }
    const action = this.#gk.preparePlaylistReorder(this.#logicalId, rangeStart, insertBefore, length);
    await this.#gk.submitActionForApproval(this.#queue, action);
  }

  async replaceTracks(trackUris: string[]): Promise<void> {
    if (trackUris.length > MAX_PLAYLIST_URIS_PER_CALL) {
      throw new Error(`replaceTracks(): at most ${MAX_PLAYLIST_URIS_PER_CALL} URIs per call.`);
    }
    const uris = trackUris.map(toTrackUri);
    await this.#gk.assertEditablePlaylist(this.#logicalId);
    const action = this.#gk.preparePlaylistReplace(this.#logicalId, uris);
    await this.#gk.submitActionForApproval(this.#queue, action);
  }

  async changeDetails(update: SpotifyPlaylistDetailsUpdate): Promise<void> {
    if (Object.keys(update).length === 0) return;
    if (update.public === true && update.collaborative === true) {
      throw new Error("changeDetails(): a collaborative playlist must be private (public and collaborative cannot both be true).");
    }
    await this.#gk.assertEditablePlaylist(this.#logicalId);
    const action = this.#gk.preparePlaylistDetails(this.#logicalId, update);
    await this.#gk.submitActionForApproval(this.#queue, action);
  }

  async unfollow(): Promise<void> {
    const action = this.#gk.preparePlaylistUnfollow(this.#logicalId);
    await this.#gk.submitActionForApproval(this.#queue, action);
  }

  async follow(): Promise<void> {
    const action = this.#gk.preparePlaylistFollow(this.#logicalId);
    await this.#gk.submitActionForApproval(this.#queue, action);
  }

  async isFollowing(): Promise<boolean> {
    const result = await this.#gk.isFollowingPlaylist(this.#logicalId);
    await this.#queue.authorizeObservation({
      title: "Check playlist follow status",
      description: "Check whether this playlist is in your library.",
    });
    return result;
  }
}

@validateRpc()
export class SpotifyAccountSessionImpl extends RpcTarget implements SpotifyAccountSession {
  #gk: SpotifyGatekeeperImpl;
  #queue: RpcStub<ApprovalQueue>;

  constructor(gk: SpotifyGatekeeperImpl, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#gk = gk;
    this.#queue = queue;
  }

  [Symbol.dispose](): void {
    disposeQueue(this.#queue);
  }

  async getProfile(): Promise<SpotifyProfile> {
    const profile = await this.#gk.getProfile();
    await this.#queue.authorizeObservation({
      title: "Read Spotify profile",
      description: `Read the connected Spotify account's profile (${profile.displayName ?? profile.id}).`,
    });
    return profile;
  }

  @skipRpcValidation()
  async search(query: string, types: string[], limit?: number): Promise<SpotifySearchResults> {
    if (typeof query !== "string" || query.trim() === "") {
      throw new Error("search(): query must be a non-empty string.");
    }
    if (!Array.isArray(types) || types.length === 0) {
      throw new Error("search(): provide at least one type (track, artist, album, or playlist).");
    }
    for (const type of types) {
      if (typeof type !== "string" || !SEARCH_TYPES.has(type)) {
        throw new Error(`search(): unknown type "${type}". Valid types: track, artist, album, playlist.`);
      }
    }
    assertOptionalLimit(limit);
    const results = await this.#gk.search(query, types as SpotifySearchType[], limit);
    await this.#queue.authorizeObservation({
      title: `Search Spotify for "${query}"`,
      description: `Search the Spotify catalog for "${query}" (${types.join(", ")}).`,
    });
    return results;
  }

  async getTrack(trackId: string): Promise<SpotifyTrack> {
    const track = await this.#gk.getTrack(toBareId(trackId, "track"));
    await this.#queue.authorizeObservation({
      title: `Read track "${track.name}"`,
      description: `Read catalog details for the track "${track.name}".`,
    });
    return track;
  }

  async listSavedTracks(limit?: number, offset?: number): Promise<SpotifyTrack[]> {
    const tracks = await this.#gk.listSavedTracks(limit, offset);
    await this.#queue.authorizeObservation({
      title: "Read saved tracks",
      description: `Read ${tracks.length} saved track(s) from the library.`,
    });
    return tracks;
  }

  async listSavedAlbums(limit?: number, offset?: number): Promise<SpotifyAlbumRef[]> {
    const albums = await this.#gk.listSavedAlbums(limit, offset);
    await this.#queue.authorizeObservation({
      title: "Read saved albums",
      description: `Read ${albums.length} saved album(s) from the library.`,
    });
    return albums;
  }

  async areTracksSaved(trackIds: string[]): Promise<boolean[]> {
    const result = await this.#gk.areTracksSaved(trackIds.map(id => toBareId(id, "track")));
    await this.#queue.authorizeObservation({
      title: "Check saved tracks",
      description: `Check whether ${trackIds.length} track(s) are saved in the library.`,
    });
    return result;
  }

  async areAlbumsSaved(albumIds: string[]): Promise<boolean[]> {
    const result = await this.#gk.areAlbumsSaved(albumIds.map(id => toBareId(id, "album")));
    await this.#queue.authorizeObservation({
      title: "Check saved albums",
      description: `Check whether ${albumIds.length} album(s) are saved in the library.`,
    });
    return result;
  }

  @skipRpcValidation()
  async getTopTracks(timeRange?: string, limit?: number): Promise<SpotifyTrack[]> {
    if (timeRange !== undefined && (typeof timeRange !== "string" || !TOP_TIME_RANGES.has(timeRange))) {
      throw new Error(`getTopTracks(): invalid timeRange "${timeRange}". Use short_term, medium_term, or long_term.`);
    }
    assertOptionalLimit(limit);
    const tracks = await this.#gk.getTopTracks(timeRange as SpotifyTopTimeRange | undefined, limit);
    await this.#queue.authorizeObservation({
      title: "Read top tracks",
      description: `Read the user's top ${tracks.length} track(s).`,
    });
    return tracks;
  }

  @skipRpcValidation()
  async getTopArtists(timeRange?: string, limit?: number): Promise<SpotifyArtistRef[]> {
    if (timeRange !== undefined && (typeof timeRange !== "string" || !TOP_TIME_RANGES.has(timeRange))) {
      throw new Error(`getTopArtists(): invalid timeRange "${timeRange}". Use short_term, medium_term, or long_term.`);
    }
    assertOptionalLimit(limit);
    const artists = await this.#gk.getTopArtists(timeRange as SpotifyTopTimeRange | undefined, limit);
    await this.#queue.authorizeObservation({
      title: "Read top artists",
      description: `Read the user's top ${artists.length} artist(s).`,
    });
    return artists;
  }

  async saveTracks(trackIds: string[]): Promise<void> {
    if (trackIds.length === 0) return;
    trackIds = trackIds.map(id => toBareId(id, "track"));
    const action = this.#gk.prepareSaveTracks(trackIds);
    await this.#gk.submitActionForApproval(this.#queue, action);
  }

  async removeSavedTracks(trackIds: string[]): Promise<void> {
    if (trackIds.length === 0) return;
    trackIds = trackIds.map(id => toBareId(id, "track"));
    const action = this.#gk.prepareRemoveSavedTracks(trackIds);
    await this.#gk.submitActionForApproval(this.#queue, action);
  }

  async saveAlbums(albumIds: string[]): Promise<void> {
    if (albumIds.length === 0) return;
    albumIds = albumIds.map(id => toBareId(id, "album"));
    const action = this.#gk.prepareSaveAlbums(albumIds);
    await this.#gk.submitActionForApproval(this.#queue, action);
  }

  async removeSavedAlbums(albumIds: string[]): Promise<void> {
    if (albumIds.length === 0) return;
    albumIds = albumIds.map(id => toBareId(id, "album"));
    const action = this.#gk.prepareRemoveSavedAlbums(albumIds);
    await this.#gk.submitActionForApproval(this.#queue, action);
  }

  async followArtists(artistIds: string[]): Promise<void> {
    if (artistIds.length === 0) return;
    artistIds = artistIds.map(id => toBareId(id, "artist"));
    const action = this.#gk.prepareFollowArtists(artistIds);
    await this.#gk.submitActionForApproval(this.#queue, action);
  }

  async unfollowArtists(artistIds: string[]): Promise<void> {
    if (artistIds.length === 0) return;
    artistIds = artistIds.map(id => toBareId(id, "artist"));
    const action = this.#gk.prepareUnfollowArtists(artistIds);
    await this.#gk.submitActionForApproval(this.#queue, action);
  }

  async isFollowingArtists(artistIds: string[]): Promise<boolean[]> {
    const result = await this.#gk.areArtistsFollowed(artistIds.map(id => toBareId(id, "artist")));
    await this.#queue.authorizeObservation({
      title: "Check followed artists",
      description: `Check whether ${artistIds.length} artist(s) are followed.`,
    });
    return result;
  }

  async listPlaylists(limit?: number, offset?: number): Promise<SpotifyPlaylistSummary[]> {
    const playlists = await this.#gk.listPlaylists(limit, offset);
    await this.#queue.authorizeObservation({
      title: "List playlists",
      description: `List ${playlists.length} of the user's playlists.`,
    });
    return playlists;
  }

  getPlaylist(playlistId: string): SpotifyPlaylist {
    // Accept a bare id, an open.spotify.com URL, a spotify:playlist: URI, or a "~N" pending id;
    // reject anything malformed up front (rather than leaking a Spotify "Invalid base62 id").
    const logicalId = toPlaylistLogicalId(playlistId);
    return new SpotifyPlaylistImpl(this.#gk, this.#queue.dup(), logicalId);
  }

  async createPlaylist(
    name: string,
    options?: { description?: string; public?: boolean; collaborative?: boolean },
  ): Promise<SpotifyPlaylist> {
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error("createPlaylist(): name must be a non-empty string.");
    }
    if (options?.public === true && options?.collaborative === true) {
      throw new Error("createPlaylist(): a collaborative playlist must be private (public and collaborative cannot both be true).");
    }
    const action = this.#gk.preparePlaylistCreate(name, options);
    await this.#gk.submitActionForApproval(this.#queue, action);
    return new SpotifyPlaylistImpl(this.#gk, this.#queue.dup(), action.provisionalId);
  }

  getPlayer(): SpotifyPlayer {
    return new SpotifyPlayerImpl(this.#gk, this.#queue.dup());
  }
}
