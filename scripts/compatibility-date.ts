/**
 * Workers runtime compatibility date of every Worker in this repo, and of the vitest pools that
 * model them.
 *
 * This constant's only dependency is the string itself: workerd-bundled runtime code (see
 * overseer-harness/facets/publishing) imports it directly, while scripts/worker-config.ts — which
 * pulls in @cloudflare/config, a Node-only config loader — re-exports it for Node-side importers.
 * Keeping the value here keeps the Node-only module out of the worker bundle graph.
 */
export const COMPATIBILITY_DATE = "2026-09-04";
