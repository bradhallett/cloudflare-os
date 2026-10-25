// REST catalog assembly and its cache shape (plans/composio-gatekeeper.md "Surface"): the
// account DO assembles the catalog from `GET /toolkits` + an unfiltered `GET /tools` — two
// global cursor sweeps, never the session's MCP listing — and filters meta-tool slugs out of
// every snapshot.

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
 * Assemble a full catalog snapshot from the REST surface in two global cursor sweeps — one over
 * `GET /toolkits`, one over an unfiltered `GET /tools` — assembling tool→toolkit in memory. At
 * Composio's documented ~1,600 toolkits a per-toolkit fan-out would blow the Workers
 * subrequest cap on a cold cache; two sweeps cost a handful of requests however large the
 * catalog is. Meta-tool slugs are filtered everywhere; the tool map is keyed by exact slug.
 */
export async function assembleCatalog(api: ComposioApi): Promise<CatalogSnapshot> {
  const toolkits: ToolkitSummary[] = [];
  await api.forEachToolkit((batch) => toolkits.push(...batch));
  const toolsBySlug = new Map<string, ToolInfo>();
  await api.forEachAllTools((batch) => {
    for (const tool of batch) {
      if (!isMetaTool(tool.slug)) toolsBySlug.set(tool.slug, tool);
    }
  });
  const toolCounts = new Map<string, number>();
  for (const tool of toolsBySlug.values()) {
    toolCounts.set(tool.toolkitSlug, (toolCounts.get(tool.toolkitSlug) ?? 0) + 1);
  }
  const entries: CatalogEntry[] = toolkits.map((toolkit) => ({
    ...toolkit,
    toolCount: toolCounts.get(toolkit.slug) ?? 0,
  }));
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
