// The connect-flow subject pinning for the Spotify gatekeeper: which Spotify account a connection
// belongs to, how that account is read from a fresh grant, and the refusal shown when a reconnect
// comes back as anyone else. Kept beside `action-state.ts` so the account Durable Object wires
// these decisions in without growing the (already large) `spotify.ts`.

import type { ConnectHandoff } from "@gadgets/workshop-shared/gatekeeper";
import type { ConnectionSubject } from "@gadgets/gatekeeper-kit/credential-stage";
import { SpotifyApi } from "./spotify-api";

/**
 * The Spotify account a connection is pinned to, by the canonical user id `/v1/me` reports. A
 * reconnect that comes back as anyone else is refused (Spotify exposes no token-revocation
 * endpoint, so the refused grant is simply dropped).
 */
export type PinnedSubject = ConnectionSubject & { displayName: string | null };

/** How the callback ended: a handoff for the browser, or a refusal to show there. */
export type CallbackResult = { handoff: ConnectHandoff } | { refused: { title: string; detail: string } };

/** Reads the Spotify user an access token belongs to. */
export async function fetchSubject(accessToken: string): Promise<PinnedSubject> {
  const user = await new SpotifyApi(async () => accessToken).getCurrentUser();
  return { id: user.id, displayName: user.display_name ?? null };
}

/** A pinned subject's name, for refusal messages; Spotify can leave the display name empty. */
function subjectName(subject: PinnedSubject): string {
  return subject.displayName ?? `Spotify user ${subject.id}`;
}

/** The refusal the kit reports for a reconnect that came back as a different Spotify account. */
export function pinRefusal(pinned: PinnedSubject, granted: PinnedSubject): { title: string; detail: string } {
  return {
    title: "That's a different Spotify account",
    detail: `This connection is for ${subjectName(pinned)}, but Spotify authorized ${subjectName(granted)}. ` +
      `Sign in to Spotify as ${subjectName(pinned)} and reconnect, or connect ${subjectName(granted)} ` +
      "as a separate account.",
  };
}
