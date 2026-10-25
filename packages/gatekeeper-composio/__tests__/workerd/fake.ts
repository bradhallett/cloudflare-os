// Plain-JSON builders for the fake Composio REST surface the workerd suites install through the
// TestHooks. This module is deliberately import-free: it loads in the test context's module
// registry, and anything worker-side here would be a second copy of worker state.

export const READ_TOOL = "GITHUB_GET_ISSUE";
export const WRITE_TOOL = "GITHUB_CREATE_ISSUE";
export const DESTRUCTIVE_TOOL = "GITHUB_DELETE_REPO";

/** One planned execute response (structurally the TestHooks' FakeExecuteSpec). */
export type FakeExecute =
  | { resultType: "completed"; result?: unknown }
  | { resultType: "failed"; error: string }
  | { resultType: "blocked"; error: string; logId?: string | null }
  | {
      resultType: "input_required"; requestState: string;
      inputRequests: { id: string; question: string; options?: string[] }[];
    }
  /** A plain HTTP failure status (e.g. a definite pre-execution 4xx). */
  | { status: number; error?: string };

/** The one toolkit every suite's fake catalog serves. */
export function githubSpec(executes: FakeExecute[]): {
  toolkits: { slug: string; name: string; description?: string }[];
  tools: Record<string, {
    slug: string; name?: string; description?: string;
    tags?: string[]; read_only_hint?: boolean | null;
  }[]>;
  executes: FakeExecute[];
} {
  return {
    toolkits: [{ slug: "github", name: "GitHub", description: "GitHub tools" }],
    tools: {
      github: [
        {
          slug: READ_TOOL, name: "Get issue", description: "Reads one issue.",
          tags: [], read_only_hint: true,
        },
        {
          slug: WRITE_TOOL, name: "Create issue", description: "Creates an issue.",
          tags: ["createHint"], read_only_hint: false,
        },
        {
          slug: DESTRUCTIVE_TOOL, name: "Delete repository",
          description: "Deletes a repository.",
          tags: ["updateHint", "destructiveHint"], read_only_hint: false,
        },
      ],
    },
    executes,
  };
}
