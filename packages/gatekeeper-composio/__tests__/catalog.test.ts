import { describe, expect, it } from "vitest";
import type { ComposioApi, ToolInfo, ToolkitSummary } from "../src/composio-api.js";
import { assembleCatalog, findToolkit, toolsForToolkit } from "../src/catalog.js";

function tool(slug: string, toolkitSlug: string, extra: Partial<ToolInfo> = {}): ToolInfo {
  return {
    slug, toolkitSlug, name: slug, tags: [], readOnlyHint: null, ...extra,
  };
}

function fakeApi(toolkits: ToolkitSummary[], tools: ToolInfo[]): {
  api: ComposioApi;
  toolCalls: string[];
} {
  const toolCalls: string[] = [];
  const api = {
    forEachToolkit: async (page: (batch: ToolkitSummary[]) => void) => {
      toolCalls.push("/toolkits");
      page(toolkits.slice(0, 2));
      if (toolkits.length > 2) page(toolkits.slice(2));
    },
    forEachAllTools: async (page: (batch: ToolInfo[]) => void) => {
      toolCalls.push("/tools");
      page(tools.slice(0, 3));
      page(tools.slice(3));
    },
    forEachTool: async () => {
      throw new Error("catalog assembly never walks tools per toolkit");
    },
  } as unknown as ComposioApi;
  return { api, toolCalls };
}

const SUMMARIES: ToolkitSummary[] = [
  { slug: "github", name: "GitHub" },
  { slug: "slack", name: "Slack", description: "chat" },
  { slug: "composio_core", name: "Composio Core", logo: "https://logo" },
];

const TOOLS: ToolInfo[] = [
  tool("GITHUB_CREATE_ISSUE", "github", { tags: ["createHint"] }),
  tool("GITHUB_SEARCH_REPOS", "github", { readOnlyHint: true }),
  tool("SLACK_SEND_MESSAGE", "slack"),
  // Meta-tools that must be filtered everywhere.
  tool("COMPOSIO_REMOTE_BASH_TOOL", "composio_core"),
  tool("COMPOSIO_SEARCH_TOOLS", "composio_core"),
  tool("MULTI_EXECUTE_TOOL", "composio_core"),
  tool("COMPOSIO_INTERNAL_TOOL", "composio_core"),
];

describe("assembleCatalog", () => {
  it("assembles entries with per-toolkit non-meta tool counts", async () => {
    const { api } = fakeApi(SUMMARIES, TOOLS);
    const snapshot = await assembleCatalog(api);
    expect(snapshot.entries).toEqual([
      { slug: "github", name: "GitHub", description: undefined, logo: undefined, toolCount: 2 },
      { slug: "slack", name: "Slack", description: "chat", logo: undefined, toolCount: 1 },
      { slug: "composio_core", name: "Composio Core", description: undefined,
        logo: "https://logo", toolCount: 1 },
    ]);
    expect(snapshot.assembledAt).toBeGreaterThan(0);
  });

  it("filters meta-tool slugs from the tool map", async () => {
    const { api } = fakeApi(SUMMARIES, TOOLS);
    const snapshot = await assembleCatalog(api);
    expect(snapshot.toolsBySlug.has("COMPOSIO_REMOTE_BASH_TOOL")).toBe(false);
    expect(snapshot.toolsBySlug.has("COMPOSIO_SEARCH_TOOLS")).toBe(false);
    expect(snapshot.toolsBySlug.has("MULTI_EXECUTE_TOOL")).toBe(false);
    expect(snapshot.toolsBySlug.size).toBe(4);
  });

  it("sweeps tools globally once, never per toolkit, honoring pagination batches", async () => {
    const { api, toolCalls } = fakeApi(SUMMARIES, TOOLS);
    await assembleCatalog(api);
    // Two sweeps total however many toolkits exist — a per-toolkit fan-out would blow the
    // Workers subrequest cap on a cold cache (review finding B1).
    expect(toolCalls).toEqual(["/toolkits", "/tools"]);
  });

  it("handles a toolkit with no tools", async () => {
    const { api } = fakeApi([{ slug: "empty", name: "Empty" }], []);
    const snapshot = await assembleCatalog(api);
    expect(findToolkit(snapshot, "empty")?.toolCount).toBe(0);
    expect(toolsForToolkit(snapshot, "empty")).toEqual([]);
  });
});

describe("toolsForToolkit", () => {
  it("partitions tools by exact toolkit slug", async () => {
    const { api } = fakeApi(SUMMARIES, TOOLS);
    const snapshot = await assembleCatalog(api);
    expect(toolsForToolkit(snapshot, "github").map((t) => t.slug))
      .toEqual(["GITHUB_CREATE_ISSUE", "GITHUB_SEARCH_REPOS"]);
    expect(toolsForToolkit(snapshot, "composio_core").map((t) => t.slug))
      .toEqual(["COMPOSIO_INTERNAL_TOOL"]);
    expect(toolsForToolkit(snapshot, "nonexistent")).toEqual([]);
  });
});

describe("findToolkit", () => {
  it("finds by exact slug and rejects lookalikes", async () => {
    const { api } = fakeApi(SUMMARIES, TOOLS);
    const snapshot = await assembleCatalog(api);
    expect(findToolkit(snapshot, "github")?.name).toBe("GitHub");
    expect(findToolkit(snapshot, "GITHUB")).toBeUndefined();
    expect(findToolkit(snapshot, "github2")).toBeUndefined();
  });
});
