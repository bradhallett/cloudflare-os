// Normalization of raw Spotify Web API responses into the gatekeeper's public types, plus
// the id/URI parsing helpers shared by the gatekeeper, its sessions, and the configurators.

import {
  type SpotifyAlbumResponse,
  type SpotifyArtistResponse,
  type SpotifyDeviceResponse,
  type SpotifyPlaybackStateResponse,
  type SpotifyPlaylistResponse,
  type SpotifyTrackResponse,
  type SpotifyUserResponse,
} from "./spotify-api";
import {
  type SpotifyAlbumRef,
  type SpotifyArtistRef,
  type SpotifyDevice,
  type SpotifyImage,
  type SpotifyPlaybackState,
  type SpotifyPlaylistSummary,
  type SpotifyProfile,
  type SpotifyRepeatMode,
  type SpotifyTopTimeRange,
  type SpotifyTrack,
  type SpotifyUserRef,
} from "./types";

/**
 * Extract a playlist ID from an open.spotify.com URL, a spotify:playlist:ID URI, or a bare ID.
 */
export function parsePlaylistId(input: string): string | null {
  const trimmed = input.trim();
  const uriMatch = /^spotify:playlist:([A-Za-z0-9]+)$/.exec(trimmed);
  if (uriMatch) return uriMatch[1];
  if (/^[A-Za-z0-9]{16,}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (!/(^|\.)spotify\.com$/.test(url.hostname)) return null;
    const segments = url.pathname.split("/").filter(Boolean);
    const idx = segments.indexOf("playlist");
    if (idx >= 0 && segments[idx + 1]) return segments[idx + 1];
  } catch {
    // not a URL
  }
  return null;
}

export function profileUrl(userId: string): string {
  return `https://open.spotify.com/user/${userId}`;
}

export function playlistUrl(playlistId: string): string {
  return `https://open.spotify.com/playlist/${playlistId}`;
}

// ---------------------------------------------------------------------------
// Normalizers: raw Spotify responses -> the shapes declared in types.d.ts.

export function normalizeImages(
  images: { url: string; width?: number | null; height?: number | null }[] | null | undefined,
): SpotifyImage[] {
  return (images ?? []).map(image => ({
    url: image.url,
    width: image.width ?? null,
    height: image.height ?? null,
  }));
}

export function externalUrl(value: { external_urls?: { spotify?: string } }, fallback: string): string {
  return value.external_urls?.spotify ?? fallback;
}

export function normalizeArtistRef(artist: SpotifyArtistResponse): SpotifyArtistRef {
  return {
    id: artist.id,
    name: artist.name,
    uri: artist.uri,
    url: externalUrl(artist, `https://open.spotify.com/artist/${artist.id}`),
  };
}

export function normalizeAlbumRef(album: SpotifyAlbumResponse): SpotifyAlbumRef {
  return {
    id: album.id,
    name: album.name,
    uri: album.uri,
    url: externalUrl(album, `https://open.spotify.com/album/${album.id}`),
    albumType: album.album_type ?? "album",
    releaseDate: album.release_date ?? "",
    totalTracks: album.total_tracks ?? 0,
    images: normalizeImages(album.images),
    artists: (album.artists ?? []).map(normalizeArtistRef),
  };
}

export function normalizeUserRef(user: SpotifyUserResponse): SpotifyUserRef {
  return {
    id: user.id,
    displayName: user.display_name ?? null,
    uri: user.uri,
    url: externalUrl(user, profileUrl(user.id)),
  };
}

export function normalizeTrack(track: SpotifyTrackResponse): SpotifyTrack {
  return {
    id: track.id,
    name: track.name,
    uri: track.uri,
    url: externalUrl(track, `https://open.spotify.com/track/${track.id}`),
    artists: (track.artists ?? []).map(normalizeArtistRef),
    album: normalizeAlbumRef(track.album),
    durationMs: track.duration_ms,
    explicit: track.explicit,
    popularity: track.popularity ?? null,
    discNumber: track.disc_number ?? 1,
    trackNumber: track.track_number ?? 0,
    isLocal: track.is_local ?? false,
  };
}

export function normalizeProfile(user: SpotifyUserResponse): SpotifyProfile {
  return {
    id: user.id,
    displayName: user.display_name ?? null,
    email: user.email ?? null,
    product: user.product ?? null,
    country: user.country ?? null,
    followerCount: user.followers?.total ?? 0,
    uri: user.uri,
    url: externalUrl(user, profileUrl(user.id)),
    images: normalizeImages(user.images),
  };
}

export function normalizePlaylistSummary(playlist: SpotifyPlaylistResponse): SpotifyPlaylistSummary {
  return {
    id: playlist.id,
    name: playlist.name,
    uri: playlist.uri,
    url: externalUrl(playlist, playlistUrl(playlist.id)),
    description: playlist.description ?? null,
    owner: normalizeUserRef(playlist.owner),
    public: playlist.public ?? null,
    collaborative: playlist.collaborative ?? false,
    // Feb 2026 renamed `tracks` -> `items`; for playlists the user doesn't own the count container
    // may be absent entirely, in which case this is 0 (contents are withheld by Spotify).
    trackCount: playlist.items?.total ?? playlist.tracks?.total ?? 0,
    images: normalizeImages(playlist.images),
    snapshotId: playlist.snapshot_id,
  };
}

export function normalizeDevice(device: SpotifyDeviceResponse): SpotifyDevice {
  return {
    id: device.id,
    name: device.name,
    type: device.type,
    isActive: device.is_active,
    volumePercent: device.volume_percent,
    supportsVolume: device.supports_volume ?? device.volume_percent !== null,
  };
}

export function normalizeRepeat(state?: string): SpotifyRepeatMode {
  return state === "track" || state === "context" ? state : "off";
}

export function normalizePlaybackState(state: SpotifyPlaybackStateResponse | undefined): SpotifyPlaybackState {
  if (!state) {
    return {
      isPlaying: false,
      device: null,
      track: null,
      progressMs: null,
      shuffle: false,
      repeat: "off",
      contextUri: null,
    };
  }
  return {
    isPlaying: state.is_playing,
    device: state.device ? normalizeDevice(state.device) : null,
    track: state.item ? normalizeTrack(state.item) : null,
    progressMs: state.progress_ms ?? null,
    shuffle: state.shuffle_state ?? false,
    repeat: normalizeRepeat(state.repeat_state),
    contextUri: state.context?.uri ?? null,
  };
}

/**
 * Validate a caller-supplied limit (Spotify's minimum is 1). Throws on invalid input — consistent
 * with clampOffset — and clamps down to the per-endpoint max. `undefined` uses the default.
 */
export function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined) return fallback;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
    throw new Error("limit must be a positive integer.");
  }
  return Math.min(limit, max);
}

export function clampOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
    throw new Error("offset must be a non-negative integer.");
  }
  return offset;
}

export function normalizeTimeRange(range: SpotifyTopTimeRange | undefined): string {
  return range === "short_term" || range === "long_term" ? range : "medium_term";
}
