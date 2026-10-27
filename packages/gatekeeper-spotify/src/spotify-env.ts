// The Spotify gatekeeper's environment shape, base-URL helpers, and the props the Overseer
// instantiates the per-binding gatekeeper DO with. Shared by the account/entrypoint half
// (spotify.ts) and the gatekeeper-DO half (spotify-gatekeeper.ts) so neither imports the other.

import { stripTrailingSlashes } from "@gadgets/workshop-shared/gatekeeper";

export type Env = Cloudflare.Env & {
  BASE_URL?: string;
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
};

type ResourceKind = "account" | "playlist";

export type SpotifyGatekeeperImplProps = {
  userObjectId: string;
  resourceKind: ResourceKind;
  playlistId?: string;
};

export function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/spotify");
}

export function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

export function ensureConfigured(env: Env): asserts env is Env & { CLIENT_ID: string; CLIENT_SECRET: string } {
  if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
    throw new Error("The Spotify gatekeeper is not configured.");
  }
}
