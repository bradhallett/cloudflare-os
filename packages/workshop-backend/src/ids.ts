// Canonical minters for the random identifiers backend records key things by.

/**
 * Mints a random 128-bit identifier as 32 lowercase hex digits — the id shape of an org (its
 * Durable Object name) and of a published blueprint's content id. Opaque and collision-safe:
 * nothing decodes the digits, so the only operations on one are mint, store, and compare.
 */
export function random128BitId(): string {
  let idBytes = new Uint8Array(16);
  crypto.getRandomValues(idBytes);
  return idBytes.toHex();
}
