// The Spotify action model: action record types, approver-facing descriptions, the
// provider-domain helpers the apply/simulate paths share, and the data-driven engine table
// (SPOTIFY_ACTIONS) that claims, applies, simulates and reverts every queued write against
// the host operations declared by SpotifyActionHost.

import {
  buildDescription,
  type RenderedDescription,
} from "@gadgets/gatekeeper-kit/action-description";
import {
  ActionJournal,
  type ActionJournalKv,
  defineActions,
  type TaggedAction,
} from "@gadgets/gatekeeper-kit/actions";
import { SpotifyApi } from "./spotify-api";
import {
  type SpotifyPlaylistSummary,
  type SpotifyRepeatMode,
  type SpotifyTrack,
  type SpotifyUserRef,
  type SpotifyPlaylistDetailsUpdate,
} from "./types";

import { normalizePlaylistSummary } from "./spotify-normalize";

// ---------------------------------------------------------------------------
// Action model, caching, and simulation (gatekeeper responsibilities 4-6).
//
// Every write is submitted to the ApprovalQueue and stored as a pending action; it is only
// performed against Spotify when applyAction() is later called. Reads overlay pending actions so
// the caller sees the world as if its queued edits had already been applied (simulation). Playback
// commands are the exception: they are gated like any action but, being live external state, are
// never simulated.

export type WithApi = <T>(fn: (api: SpotifyApi) => Promise<T>) => Promise<T>;

export type BaseAction = { submittedAt: number };

export type SaveTracksAction = BaseAction & { type: "saveTracks"; trackIds: string[] };
export type RemoveSavedTracksAction = BaseAction & { type: "removeSavedTracks"; trackIds: string[] };
export type SaveAlbumsAction = BaseAction & { type: "saveAlbums"; albumIds: string[] };
export type RemoveSavedAlbumsAction = BaseAction & { type: "removeSavedAlbums"; albumIds: string[] };
export type FollowArtistsAction = BaseAction & { type: "followArtists"; artistIds: string[] };
export type UnfollowArtistsAction = BaseAction & { type: "unfollowArtists"; artistIds: string[] };
export type PlaylistCreateAction = BaseAction & {
  type: "playlistCreate";
  provisionalId: string;
  name: string;
  description?: string;
  /**
   * Set at prepare to what Spotify would assume when omitted, so apply sends, and the approver
   * reads, the real visibility. Absent only on records staged before that was done.
   */
  public?: boolean;
  collaborative?: boolean;
};
export type PlaylistAddAction = BaseAction & { type: "playlistAdd"; playlistId: string; uris: string[]; position?: number };
export type PlaylistRemoveAction = BaseAction & { type: "playlistRemove"; playlistId: string; uris: string[] };
export type PlaylistReorderAction = BaseAction & {
  type: "playlistReorder"; playlistId: string; rangeStart: number; insertBefore: number; rangeLength: number;
};
export type PlaylistReplaceAction = BaseAction & { type: "playlistReplace"; playlistId: string; uris: string[] };
export type PlaylistDetailsAction = BaseAction & { type: "playlistDetails"; playlistId: string; update: SpotifyPlaylistDetailsUpdate };
export type PlaylistUnfollowAction = BaseAction & { type: "playlistUnfollow"; playlistId: string };
export type PlaylistFollowAction = BaseAction & { type: "playlistFollow"; playlistId: string };

export type PlayerCommand =
  | { op: "play"; deviceId?: string; body: Record<string, unknown> }
  | { op: "pause"; deviceId?: string }
  | { op: "next"; deviceId?: string }
  | { op: "previous"; deviceId?: string }
  | { op: "seek"; positionMs: number; deviceId?: string }
  | { op: "setVolume"; volumePercent: number; deviceId?: string }
  | { op: "setShuffle"; shuffle: boolean; deviceId?: string }
  | { op: "setRepeat"; mode: SpotifyRepeatMode; deviceId?: string }
  | { op: "transfer"; deviceId: string; play: boolean }
  | { op: "addToQueue"; uri: string; deviceId?: string };
export type PlayerAction = BaseAction & { type: "player"; command: PlayerCommand };

export type PlaylistTrackAction =
  PlaylistAddAction | PlaylistRemoveAction | PlaylistReorderAction | PlaylistReplaceAction;

export type SpotifyAction =
  | SaveTracksAction | RemoveSavedTracksAction | SaveAlbumsAction | RemoveSavedAlbumsAction
  | FollowArtistsAction | UnfollowArtistsAction
  | PlaylistCreateAction | PlaylistTrackAction | PlaylistDetailsAction
  | PlaylistUnfollowAction | PlaylistFollowAction
  | PlayerAction;

/**
 * The approver-facing text for a prepared action, rendered from the payload that will be applied
 * so every id, URI, name and request body the agent chose is there to read in full.
 */
export function describeSpotifyAction(action: SpotifyAction): RenderedDescription {
  switch (action.type) {
    case "saveTracks":
      return buildDescription(`Save ${action.trackIds.length} track(s) to the library.`)
        .list("Track IDs", action.trackIds).finish();
    case "removeSavedTracks":
      return buildDescription(`Remove ${action.trackIds.length} track(s) from the library.`)
        .list("Track IDs", action.trackIds).finish();
    case "saveAlbums":
      return buildDescription(`Save ${action.albumIds.length} album(s) to the library.`)
        .list("Album IDs", action.albumIds).finish();
    case "removeSavedAlbums":
      return buildDescription(`Remove ${action.albumIds.length} album(s) from the library.`)
        .list("Album IDs", action.albumIds).finish();
    case "followArtists":
      return buildDescription(`Follow ${action.artistIds.length} artist(s).`)
        .list("Artist IDs", action.artistIds).finish();
    case "unfollowArtists":
      return buildDescription(`Unfollow ${action.artistIds.length} artist(s).`)
        .list("Artist IDs", action.artistIds).finish();
    case "playlistCreate":
      return buildDescription(`Create a new ${action.public ? "public" : "private"}` +
        `${action.collaborative ? ", collaborative" : ""} playlist.`)
        .inline("Provisional ID", action.provisionalId)
        .inline("Name", action.name)
        .verbatim("Description", action.description ?? "")
        .finish();
    case "playlistAdd":
      return buildDescription(`Add ${action.uris.length} track(s) to the playlist` +
        `${action.position === undefined ? "" : ` at position ${action.position}`}.`)
        .inline("Playlist", action.playlistId)
        .list("Track URIs", action.uris)
        .finish();
    case "playlistRemove":
      return buildDescription(
        `Remove every occurrence of the ${action.uris.length} track URI(s) below from the playlist.`)
        .inline("Playlist", action.playlistId)
        .list("Track URIs", action.uris)
        .finish();
    case "playlistReorder":
      return buildDescription(`Move ${action.rangeLength} track(s) from position ` +
        `${action.rangeStart} to before position ${action.insertBefore}.`)
        .inline("Playlist", action.playlistId)
        .finish();
    case "playlistReplace":
      return buildDescription(
        `Replace the playlist's contents with ${action.uris.length} track(s).`)
        .inline("Playlist", action.playlistId)
        .list("Track URIs", action.uris)
        .finish();
    case "playlistDetails": {
      const { update } = action;
      const builder = buildDescription("Update the playlist's details.")
        .inline("Playlist", action.playlistId);
      if (update.name !== undefined) builder.inline("Name", update.name);
      if (update.description !== undefined) builder.verbatim("Description", update.description);
      if (update.public !== undefined) builder.inline("Public", String(update.public));
      if (update.collaborative !== undefined) {
        builder.inline("Collaborative", String(update.collaborative));
      }
      return builder.finish();
    }
    case "playlistUnfollow":
      return buildDescription(
        "Remove this playlist from your library (for a playlist you own, this deletes it).")
        .inline("Playlist", action.playlistId).finish();
    case "playlistFollow":
      return buildDescription("Follow this playlist (add it to your library).")
        .inline("Playlist", action.playlistId).finish();
    case "player":
      return describePlayerCommand(action.command);
  }
}

export function describePlayerCommand(command: PlayerCommand): RenderedDescription {
  const builder = (() => {
    switch (command.op) {
      case "play":
        return buildDescription("Start or resume Spotify playback.")
          .json("Request body", command.body);
      case "pause": return buildDescription("Pause Spotify playback.");
      case "next": return buildDescription("Skip to the next track.");
      case "previous": return buildDescription("Skip to the previous track.");
      case "seek": return buildDescription(`Seek to ${command.positionMs} ms in the current track.`);
      case "setVolume": return buildDescription(`Set playback volume to ${command.volumePercent}%.`);
      case "setShuffle": return buildDescription(`Turn shuffle ${command.shuffle ? "on" : "off"}.`);
      case "setRepeat": return buildDescription(`Set repeat mode to "${command.mode}".`);
      case "transfer":
        return buildDescription(`Move playback to another device${command.play ? " and resume" : ""}.`);
      case "addToQueue":
        return buildDescription("Add a track to the playback queue.").inline("Track URI", command.uri);
    }
  })();
  if (command.deviceId !== undefined) builder.inline("Device", command.deviceId);
  return builder.finish();
}

type RevertInfo =
  | { kind: "playlistTracks"; realId: string; previousUris: string[] }
  | { kind: "playlistDetails"; realId: string; previous: SpotifyPlaylistDetailsUpdate }
  | { kind: "playlistCreate"; realId: string };

/** A retained action body: the write that was applied, plus the snapshot its revert needs. */
export type StoredActionBody = SpotifyAction & { revert?: RevertInfo };

/** One kind per action type: the map the kit's action engine resolves records through. */
type SpotifyActionKinds = { [K in SpotifyAction["type"]]: Extract<SpotifyAction, { type: K }> };

/** The record shape this gatekeeper stored before adopting the kit journal. */
type LegacyStoredAction = {
  action: SpotifyAction;
  state: "staged" | "pending" | "failed" | "approved" | "rejected";
  revert?: RevertInfo;
  appliedAt?: number;
  rejectedAt?: number;
};

/** Provider operations the apply/reject handlers of an action kind run. */
export type SpotifyActionHost = {
  withApi<T>(fn: (api: SpotifyApi) => Promise<T>): Promise<T>;
  /** Resolves a logical playlist id, refusing a provisional one that was never created. */
  requireRealPlaylistId(playlistId: string): string;
  /** Resolves a provisional id to the real Spotify id its create bound, if it applied. */
  provisionalRealId(logicalId: string): string | undefined;
  playlistSummary(realId: string): Promise<SpotifyPlaylistSummary>;
  materializePlaylist(realId: string): Promise<PlaylistEntry[]>;
  applyAddTracks(realId: string, uris: string[], position?: number): Promise<void>;
  setPlaylistTracks(realId: string, uris: string[]): Promise<void>;
  invalidatePlaylist(realId: string): void;
  bindProvisional(provisionalId: string, realId: string): void;
  dropProvisional(provisionalId: string): void;
  pruneRetiredActions(): void;
};

/**
 * Approval titles for playback commands, one per `PlayerCommand` op.
 */
export const PLAYER_COMMAND_TITLES: Record<PlayerCommand["op"], string> = {
  play: "Start/resume playback",
  pause: "Pause playback",
  next: "Skip to next track",
  previous: "Skip to previous track",
  seek: "Seek playback",
  setVolume: "Set volume",
  setShuffle: "Set shuffle",
  setRepeat: "Set repeat mode",
  transfer: "Transfer playback",
  addToQueue: "Add to queue",
};

/** The provisional ("~N") playlist reference an action depends on; a real id depends on nothing. */
export const provisionalRef = (playlistId: string): string[] => (playlistId.startsWith("~") ? [playlistId] : []);

/**
 * The pre-edit snapshot a playlist write retains for revert, when the playlist is small enough to
 * keep the stored value bounded (PLAYLIST_REVERT_SNAPSHOT_MAX). Best-effort, as before: dropped
 * unavailable items, and a replace-based restore resets added_at/added_by/snapshot_id.
 */
export async function snapshotPlaylistForRevert(host: SpotifyActionHost, realId: string): Promise<RevertInfo | undefined> {
  if ((await host.playlistSummary(realId)).trackCount > PLAYLIST_REVERT_SNAPSHOT_MAX) return undefined;
  const previous = await host.materializePlaylist(realId);
  return { kind: "playlistTracks", realId, previousUris: previous.map(entry => entry.uri).filter(Boolean) };
}

/**
 * Every queued Spotify write, on the kit's action engine. All kinds claim before they dispatch:
 * a write that loses its activation mid-apply has an unknown outcome at Spotify and must never be
 * re-dispatched by a retry, so an interrupted claim ends terminal rather than pending.
 */
export const SPOTIFY_ACTIONS = defineActions<SpotifyActionHost, SpotifyActionKinds>({
  saveTracks: {
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: a => ({ title: `Save ${a.trackIds.length} track(s)`, implementsRevert: true, ...describeSpotifyAction(a) }),
    apply: async (a, host) => { await host.withApi(api => api.saveToLibrary(a.trackIds.map(trackUri))); },
  },
  removeSavedTracks: {
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: a => ({ title: `Remove ${a.trackIds.length} saved track(s)`, implementsRevert: true, ...describeSpotifyAction(a) }),
    apply: async (a, host) => { await host.withApi(api => api.removeFromLibrary(a.trackIds.map(trackUri))); },
  },
  saveAlbums: {
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: a => ({ title: `Save ${a.albumIds.length} album(s)`, implementsRevert: true, ...describeSpotifyAction(a) }),
    apply: async (a, host) => { await host.withApi(api => api.saveToLibrary(a.albumIds.map(albumUri))); },
  },
  removeSavedAlbums: {
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: a => ({ title: `Remove ${a.albumIds.length} saved album(s)`, implementsRevert: true, ...describeSpotifyAction(a) }),
    apply: async (a, host) => { await host.withApi(api => api.removeFromLibrary(a.albumIds.map(albumUri))); },
  },
  followArtists: {
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: a => ({ title: `Follow ${a.artistIds.length} artist(s)`, implementsRevert: true, ...describeSpotifyAction(a) }),
    apply: async (a, host) => { await host.withApi(api => api.saveToLibrary(a.artistIds.map(artistUri))); },
  },
  unfollowArtists: {
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: a => ({ title: `Unfollow ${a.artistIds.length} artist(s)`, implementsRevert: true, ...describeSpotifyAction(a) }),
    apply: async (a, host) => { await host.withApi(api => api.removeFromLibrary(a.artistIds.map(artistUri))); },
  },
  playlistCreate: {
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: a => ({ title: `Create playlist "${a.name}"`, implementsRevert: true, ...describeSpotifyAction(a) }),
    provides: a => [a.provisionalId],
    apply: async (a, host) => {
      const created = await host.withApi(api => api.createPlaylist({
        name: a.name,
        description: a.description,
        public: a.public,
        collaborative: a.collaborative,
      }));
      host.bindProvisional(a.provisionalId, created.id);
      return { action: { ...a, revert: { kind: "playlistCreate", realId: created.id } } };
    },
    // The provisional playlist will never exist; the engine strands every dependent on it.
    reject: async (a, host) => { host.dropProvisional(a.provisionalId); },
  },
  playlistAdd: {
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: a => ({ title: `Add ${a.uris.length} track(s) to playlist`, implementsRevert: true, ...describeSpotifyAction(a) }),
    dependsOn: a => provisionalRef(a.playlistId),
    apply: async (a, host) => {
      const realId = host.requireRealPlaylistId(a.playlistId);
      const revert = await snapshotPlaylistForRevert(host, realId);
      await host.applyAddTracks(realId, a.uris, a.position);
      host.invalidatePlaylist(realId);
      return revert === undefined ? undefined : { action: { ...a, revert } };
    },
  },
  playlistRemove: {
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: a => ({ title: `Remove ${a.uris.length} track(s) from playlist`, implementsRevert: true, ...describeSpotifyAction(a) }),
    dependsOn: a => provisionalRef(a.playlistId),
    apply: async (a, host) => {
      const realId = host.requireRealPlaylistId(a.playlistId);
      const revert = await snapshotPlaylistForRevert(host, realId);
      await host.withApi(api => api.removePlaylistItems(realId, a.uris));
      host.invalidatePlaylist(realId);
      return revert === undefined ? undefined : { action: { ...a, revert } };
    },
  },
  playlistReorder: {
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: a => ({ title: "Reorder playlist tracks", implementsRevert: true, ...describeSpotifyAction(a) }),
    dependsOn: a => provisionalRef(a.playlistId),
    apply: async (a, host) => {
      const realId = host.requireRealPlaylistId(a.playlistId);
      const revert = await snapshotPlaylistForRevert(host, realId);
      await host.withApi(api => api.reorderPlaylistItems(realId, a.rangeStart, a.insertBefore, a.rangeLength));
      host.invalidatePlaylist(realId);
      return revert === undefined ? undefined : { action: { ...a, revert } };
    },
  },
  playlistReplace: {
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: a => ({ title: "Replace playlist tracks", implementsRevert: true, ...describeSpotifyAction(a) }),
    dependsOn: a => provisionalRef(a.playlistId),
    apply: async (a, host) => {
      const realId = host.requireRealPlaylistId(a.playlistId);
      const revert = await snapshotPlaylistForRevert(host, realId);
      await host.setPlaylistTracks(realId, a.uris);
      host.invalidatePlaylist(realId);
      return revert === undefined ? undefined : { action: { ...a, revert } };
    },
  },
  playlistDetails: {
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: a => ({ title: "Change playlist details", implementsRevert: true, ...describeSpotifyAction(a) }),
    dependsOn: a => provisionalRef(a.playlistId),
    apply: async (a, host) => {
      const realId = host.requireRealPlaylistId(a.playlistId);
      const current = normalizePlaylistSummary(await host.withApi(api => api.getPlaylist(realId)));
      const revert: RevertInfo = {
        kind: "playlistDetails",
        realId,
        previous: {
          name: current.name,
          description: current.description ?? undefined,
          public: current.public ?? undefined,
          collaborative: current.collaborative,
        },
      };
      await host.withApi(api => api.changePlaylistDetails(realId, a.update));
      host.invalidatePlaylist(realId);
      return { action: { ...a, revert } };
    },
  },
  playlistUnfollow: {
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: a => ({ title: "Remove playlist from library", implementsRevert: true, ...describeSpotifyAction(a) }),
    dependsOn: a => provisionalRef(a.playlistId),
    apply: async (a, host) => {
      const realId = host.requireRealPlaylistId(a.playlistId);
      await host.withApi(api => api.removeFromLibrary([playlistUri(realId)]));
      host.invalidatePlaylist(realId);
    },
  },
  playlistFollow: {
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: a => ({ title: "Add playlist to library", implementsRevert: true, ...describeSpotifyAction(a) }),
    dependsOn: a => provisionalRef(a.playlistId),
    apply: async (a, host) => {
      const realId = host.requireRealPlaylistId(a.playlistId);
      await host.withApi(api => api.saveToLibrary([playlistUri(realId)]));
      host.invalidatePlaylist(realId);
    },
  },
  player: {
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: a => ({
      title: PLAYER_COMMAND_TITLES[a.command.op],
      implementsRevert: false,
      ...describeSpotifyAction(a),
    }),
    apply: async (a, host) => {
      await host.withApi(async api => applyPlayerCommand(api, a.command));
    },
  },
}, {
  fence: "none",
  vendorId: "spotify",
  retainApplied: true,
  isResolvedReference: (host, ref) => host.provisionalRealId(ref) !== undefined,
  afterResolve: host => { host.pruneRetiredActions(); },
});

/** One `PlayerCommand` dispatched to the API. */
async function applyPlayerCommand(api: SpotifyApi, command: PlayerCommand): Promise<void> {
  switch (command.op) {
    case "play": await api.play(command.deviceId, command.body); return;
    case "pause": await api.pause(command.deviceId); return;
    case "next": await api.next(command.deviceId); return;
    case "previous": await api.previous(command.deviceId); return;
    case "seek": await api.seek(command.positionMs, command.deviceId); return;
    case "setVolume": await api.setVolume(command.volumePercent, command.deviceId); return;
    case "setShuffle": await api.setShuffle(command.shuffle, command.deviceId); return;
    case "setRepeat": await api.setRepeat(command.mode, command.deviceId); return;
    case "transfer": await api.transfer(command.deviceId, command.play); return;
    case "addToQueue": await api.addToQueue(command.uri, command.deviceId); return;
  }
}

/**
 * The account's action journal, keyed to the storage this gatekeeper used before adopting the kit:
 * `action:<id>` rows upgrade in place, and the last-issued `counter:approval` seeds the journal's
 * next-unused id counter.
 */
export function spotifyActionJournal(kv: ActionJournalKv): ActionJournal<TaggedAction<SpotifyActionKinds>> {
  const lastIssued = kv.get<number>("counter:approval");
  if (lastIssued !== undefined) {
    kv.put("counter:nextFreeActionId", lastIssued + 1);
    kv.delete("counter:approval");
  }
  // Old terminal rows: applied ones move into the journal's retained tier with their revert
  // snapshot folded into the retained payload; rejected ones only ever answered the lenient
  // re-decision an absent id answers too, so they are dropped.
  for (const [key, record] of kv.list<LegacyStoredAction>({ prefix: "retiredAction:" })) {
    kv.delete(key);
    if (record.state !== "approved") continue;
    kv.put(`retained:action:${key.slice("retiredAction:".length)}`, {
      v: 2,
      state: "applied",
      action: {
        kind: record.action.type,
        payload: record.revert === undefined
          ? record.action
          : { ...record.action, revert: record.revert },
      },
    });
  }
  return new ActionJournal<TaggedAction<SpotifyActionKinds>>(kv, {
    legacyKeys: { nextIdKey: "counter:nextFreeActionId", recordPrefix: "action:" },
    upgradeRecord: raw => {
      if (typeof raw !== "object" || raw === null) return undefined;
      const record = raw as LegacyStoredAction;
      if (typeof record.action?.type !== "string") return undefined;
      return { kind: record.action.type, payload: record.action } as TaggedAction<SpotifyActionKinds>;
    },
  });
}

/**
 * A track as it sits in a (possibly simulated) playlist.
 */
export type PlaylistEntry = {
  uri: string;
  track: SpotifyTrack | null;
  addedAt: Date | null;
  addedBy: SpotifyUserRef | null;
};

export type PlaylistDetailsCache = { fetchedAt: number; summary: SpotifyPlaylistSummary };

export const PLAYLIST_CACHE_TTL_MS = 15 * 1000;
export const PLAYLIST_MATERIALIZE_CAP = 10000;
/**
 * Max concurrent page fetches when materializing a large playlist (latency vs. rate-limit balance).
 */
export const PLAYLIST_FETCH_CONCURRENCY = 5;
/**
 * Playlists larger than this aren't snapshotted for revert (keeps the stored snapshot small);
 * reverting such an edit returns a "revert manually" message instead.
 */
export const PLAYLIST_REVERT_SNAPSHOT_MAX = 1000;
/**
 * How long applied/rejected action records (and their revert snapshots) are retained before being
 * pruned from DO storage, to bound long-term growth.
 */
export const RETIRED_ACTION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Don't rescan the retired keyspace more often than this (pruning is best-effort cleanup).
 */
export const RETIRED_ACTION_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const METADATA_CHUNK = 50;
export const PLAYLIST_WRITE_CHUNK = 100;

export function trackUriToId(uri: string): string | null {
  const m = /^spotify:track:([A-Za-z0-9]+)$/.exec(uri);
  return m ? m[1] : null;
}

export const trackUri = (id: string) => `spotify:track:${id}`;
export const albumUri = (id: string) => `spotify:album:${id}`;
export const artistUri = (id: string) => `spotify:artist:${id}`;
export const playlistUri = (id: string) => `spotify:playlist:${id}`;

/**
 * Extract a Spotify id from a bare id, a "spotify:<kind>:<id>" URI, or an open.spotify.com URL.
 * Returns null if unrecognizable. Spotify ids are 22-char base62, so a bare value must match that
 * to catch obviously-bogus input early.
 */
export function extractSpotifyId(input: string, kind: "track" | "album" | "artist" | "playlist"): string | null {
  const trimmed = input.trim();
  const uriMatch = new RegExp(`^spotify:${kind}:([A-Za-z0-9]+)$`).exec(trimmed);
  if (uriMatch) return uriMatch[1];
  try {
    const url = new URL(trimmed);
    if (/(^|\.)spotify\.com$/.test(url.hostname)) {
      const segments = url.pathname.split("/").filter(Boolean);
      const idx = segments.indexOf(kind);
      const candidate = idx >= 0 ? segments[idx + 1] : undefined;
      if (candidate && /^[A-Za-z0-9]+$/.test(candidate)) return candidate;
    }
  } catch {
    // not a URL
  }
  return /^[A-Za-z0-9]{22}$/.test(trimmed) ? trimmed : null;
}

/**
 * Library methods take bare ids; accept a bare id, the matching URI, or an open.spotify.com URL.
 */
export function toBareId(input: string, kind: "track" | "album" | "artist"): string {
  const id = extractSpotifyId(input, kind);
  if (id) return id;
  throw new Error(`Invalid Spotify ${kind} id "${input}". Pass a 22-character id, a "spotify:${kind}:" URI, or an open.spotify.com URL.`);
}

/**
 * Music-only scope: accept a track id, URI, or open.spotify.com/track URL; normalize to a track URI.
 */
export function toTrackUri(input: string): string {
  const id = extractSpotifyId(input, "track");
  if (id) return `spotify:track:${id}`;
  throw new Error(`Invalid Spotify track "${input}". Pass a track id, "spotify:track:<id>" URI, or open.spotify.com/track/<id> URL.`);
}

/**
 * A playback "context" is an album, playlist, or artist (id, URI, or URL).
 */
export function toContextUri(input: string): string {
  for (const kind of ["album", "playlist", "artist"] as const) {
    const id = extractSpotifyId(input, kind);
    if (id) return `spotify:${kind}:${id}`;
  }
  throw new Error(`Invalid Spotify context "${input}". Expected an album, playlist, or artist id/URI/URL.`);
}

/**
 * Resolve a playlist argument (id, URL, URI, or a "~N" pending-create placeholder) to a logical id.
 */
export function toPlaylistLogicalId(input: string): string {
  const trimmed = input.trim();
  if (/^~\d+$/.test(trimmed)) return trimmed;
  const id = extractSpotifyId(trimmed, "playlist");
  if (id) return id;
  throw new Error(`Invalid Spotify playlist id "${input}". Pass a playlist id, URL, or URI.`);
}

export const SEARCH_TYPES = new Set(["track", "artist", "album", "playlist"]);
export const TOP_TIME_RANGES = new Set(["short_term", "medium_term", "long_term"]);
export const REPEAT_MODES = new Set(["off", "track", "context"]);
export const MAX_PLAYLIST_URIS_PER_CALL = 100;
/**
 * Spotify's dev-mode search cap. We always fetch this many and slice down, so that dropped null
 * placeholders in playlist results don't shrink a small requested limit below what was asked.
 */
export const SEARCH_FETCH_MAX = 10;

/**
 * Used by methods that opt out of generated RPC validation (@skipRpcValidation) so they can emit
 * friendly domain errors instead of the framework's raw "expected union" message. Such methods
 * MUST validate every argument by hand, since the generated checks no longer run.
 */
export function assertOptionalDeviceId(deviceId: unknown): void {
  if (deviceId !== undefined && typeof deviceId !== "string") {
    throw new Error("deviceId must be a string when provided.");
  }
}

export function assertOptionalLimit(limit: unknown): void {
  if (limit !== undefined && typeof limit !== "number") {
    throw new Error("limit must be a number when provided.");
  }
}

export function isPlaylistTrackAction(action: SpotifyAction): action is PlaylistTrackAction {
  return action.type === "playlistAdd" || action.type === "playlistRemove" ||
    action.type === "playlistReorder" || action.type === "playlistReplace";
}

function entryFromUri(uri: string, meta: Map<string, SpotifyTrack>): PlaylistEntry {
  return { uri, track: meta.get(uri) ?? null, addedAt: null, addedBy: null };
}

/**
 * Apply one playlist track action to an effective entry list (read-time simulation).
 */
export function applyPlaylistTrackOverlay(
  entries: PlaylistEntry[],
  action: PlaylistTrackAction,
  meta: Map<string, SpotifyTrack>,
): PlaylistEntry[] {
  switch (action.type) {
    case "playlistAdd": {
      const additions = action.uris.map(uri => entryFromUri(uri, meta));
      const at = action.position === undefined
        ? entries.length
        : Math.max(0, Math.min(action.position, entries.length));
      return [...entries.slice(0, at), ...additions, ...entries.slice(at)];
    }
    case "playlistRemove": {
      const removeSet = new Set(action.uris);
      return entries.filter(entry => !removeSet.has(entry.uri));
    }
    case "playlistReplace":
      return action.uris.map(uri => entryFromUri(uri, meta));
    case "playlistReorder": {
      const next = [...entries];
      const block = next.splice(action.rangeStart, action.rangeLength);
      let target = action.insertBefore;
      if (action.insertBefore > action.rangeStart) target -= action.rangeLength;
      target = Math.max(0, Math.min(target, next.length));
      next.splice(target, 0, ...block);
      return next;
    }
  }
}
