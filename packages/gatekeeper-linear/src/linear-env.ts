// The worker's environment shape and base-URL helpers: where the OAuth browser flow is mounted
// (the fetch handler and the account DO's redirect URIs in linear.ts), plus the props the
// Overseer instantiates the per-binding gatekeeper DO with (linear-gatekeeper.ts).

import { stripTrailingSlashes } from "@gadgets/workshop-shared/gatekeeper";
import { obsContext } from "./observability.js";

export type Env = Cloudflare.Env & {
  BASE_URL?: string;
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
};

export function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/linear");
}

export function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

/** Props the Overseer instantiates the gatekeeper facet with: the account and resource it serves. */
export type LinearGatekeeperImplProps = {
  userObjectId: string;
  workspaceUrlKey: string;
  resourceKind: "workspace" | "team" | "issue";
  teamKeyOrId?: string;
  issueRef?: string;
};

export const VENDOR_ID = "linear";

export const logger = obsContext.createLogger({
  component: "gatekeeper.linear", vendorId: VENDOR_ID,
});
