// REST catalog assembly and its cache shape (plans/composio-gatekeeper.md "Surface"): the
// account DO assembles the catalog from `GET /toolkits` + `GET /tools`, never from the
// session's MCP listing, and filters meta-tool slugs out of every snapshot.

import { isMetaTool } from "./config.js";
import type { ComposioApi, ToolInfo, ToolkitSummary } from "./composio-api.js";

/** A toolkit plus how many of its (non-meta) tools the snapshot holds. */
export interface CatalogEntry extends ToolkitSummary {
  toolCount: number;
}

/** The assembled, cached catalog: toolkit entries, tools by exact slug, assembly timestamp. */
export interface CatalogSnapshot {
  entries: CatalogEntry[];
  toolsBySlug: Map<string, ToolInfo>;
  assembledAt: number;
}

/**
 * Assemble a full catalog snapshot from the REST surface, fetching every toolkit page then every
 * toolkit's tools. Meta-tool slugs are filtered everywhere; the tool map is keyed by exact slug.
 */
export async function assembleCatalog(api: ComposioApi): Promise<CatalogSnapshot> {
  const toolkits: ToolkitSummary[] = [];
  await api.forEachToolkit((batch) => toolkits.push(...batch));
  const toolsBySlug = new Map<string, ToolInfo>();
  const entries: CatalogEntry[] = [];
  for (const toolkit of toolkits) {
    const tools: ToolInfo[] = [];
    await api.forEachTool(toolkit.slug, (batch) => tools.push(...batch));
    for (const tool of tools) {
      if (!isMetaTool(tool.slug)) toolsBySlug.set(tool.slug, tool);
    }
    entries.push({ ...toolkit, toolCount: tools.filter((t) => !isMetaTool(t.slug)).length });
  }
  return { entries, toolsBySlug, assembledAt: Date.now() };
}

/** The (meta-tool-free) tools of one toolkit, in catalog order. */
export function toolsForToolkit(snapshot: CatalogSnapshot, slug: string): ToolInfo[] {
  return [...snapshot.toolsBySlug.values()].filter((tool) => tool.toolkitSlug === slug);
}

/** The catalog entry for an exact toolkit slug, if present. */
export function findToolkit(snapshot: CatalogSnapshot, slug: string): CatalogEntry | undefined {
  return snapshot.entries.find((entry) => entry.slug === slug);
}
