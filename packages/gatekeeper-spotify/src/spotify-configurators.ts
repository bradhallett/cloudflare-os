// Resource configurators: narrow, read-only helpers exposed to the sandboxed iframe.
// Credentials are kept private in a WeakMap keyed by the RpcTarget instance.

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import {
  SpotifyApi,
  type SpotifyPlaylistResponse,
} from "./spotify-api";
import { type SpotifyAccountConfiguratorRpc } from "./configurator/account-configurator-types";
import {
  type SpotifyConfiguratorOption,
  type SpotifyPlaylistConfiguratorRpc,
} from "./configurator/playlist-configurator-types";

import { externalUrl, parsePlaylistId, profileUrl } from "./spotify-normalize";

// ---------------------------------------------------------------------------
// Resource configurators — narrow, read-only helpers exposed to the sandboxed iframe.
// Credentials are kept private in a WeakMap keyed by the RpcTarget instance.

const configuratorTokenGetters = new WeakMap<object, () => Promise<string>>();

function configuratorApi(target: object): SpotifyApi {
  const getToken = configuratorTokenGetters.get(target);
  if (!getToken) throw new Error("Spotify configurator is not initialized.");
  return new SpotifyApi(getToken);
}

const CONFIGURATOR_OPTION_LIMIT = 50;

@validateRpc()
export class SpotifyAccountConfiguratorUI extends RpcTarget implements SpotifyAccountConfiguratorRpc {
  constructor(getToken: () => Promise<string>) {
    super();
    configuratorTokenGetters.set(this, getToken);
  }

  async resourceUrl(): Promise<string> {
    const user = await configuratorApi(this).getCurrentUser();
    return externalUrl(user, profileUrl(user.id));
  }
}

@validateRpc()
export class SpotifyPlaylistConfiguratorUI extends RpcTarget implements SpotifyPlaylistConfiguratorRpc {
  constructor(getToken: () => Promise<string>) {
    super();
    configuratorTokenGetters.set(this, getToken);
  }

  async listPlaylists(query: string): Promise<SpotifyConfiguratorOption[]> {
    const api = configuratorApi(this);
    const trimmed = query.trim();

    // A pasted URL / URI / ID: resolve it directly.
    const directId = parsePlaylistId(trimmed);
    if (directId) {
      try {
        const playlist = await api.getPlaylist(directId);
        return [playlistToOption(playlist)];
      } catch {
        // fall through to search/listing
      }
    }

    // No query: the user's own playlists.
    if (!trimmed) {
      const result = await api.listMyPlaylists(CONFIGURATOR_OPTION_LIMIT, 0);
      return (result.items ?? []).filter(Boolean).map(playlistToOption);
    }

    // Otherwise search the public catalog.
    const result = await api.search(trimmed, ["playlist"], CONFIGURATOR_OPTION_LIMIT);
    return (result.playlists?.items ?? []).filter(Boolean).map(playlistToOption);
  }
}

function playlistToOption(playlist: SpotifyPlaylistResponse): SpotifyConfiguratorOption {
  const ownerName = playlist.owner?.display_name ?? playlist.owner?.id;
  return {
    value: playlist.id,
    title: playlist.name,
    subtitle: ownerName ? `By ${ownerName}` : undefined,
    meta: (playlist.items?.total ?? playlist.tracks?.total) !== undefined
      ? `${playlist.items?.total ?? playlist.tracks?.total} tracks`
      : undefined,
  };
}
