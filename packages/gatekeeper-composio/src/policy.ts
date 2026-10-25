// The single toolkitPolicy chokepoint (plans/composio-gatekeeper.md "Admin config"): every
// consult — facet mint, catalog filter, session scope, auto-apply classification — goes through
// `ToolkitPolicy`, and an excluded slug always wins over every other list.

/**
 * Exact-slug toolkit policy. `excluded` always wins: an excluded slug is neither allowed nor
 * auto-apply eligible, even if it also appears in the auto-apply list.
 */
export class ToolkitPolicy {
  readonly #excluded: ReadonlySet<string>;
  readonly #autoApply: ReadonlySet<string>;

  /** @param excludedToolkits Exact slugs to deny. @param autoApplyToolkits Exact slugs admins marked auto-apply eligible. */
  constructor(excluded: string[], autoApply: string[]) {
    this.#excluded = new Set(excluded);
    this.#autoApply = new Set(autoApply);
  }

  /** False iff the slug is excluded (unknown slugs are allowed here; live validation happens elsewhere). */
  allows(slug: string): boolean {
    return !this.#excluded.has(slug);
  }

  /** Whether the slug is admin-listed for auto-apply AND not excluded. */
  autoApplyListed(slug: string): boolean {
    return this.#autoApply.has(slug) && this.allows(slug);
  }

  /** Copy of the excluded slugs. */
  get excludedToolkits(): string[] {
    return [...this.#excluded];
  }

  /** Copy of the admin auto-apply slugs (possibly including excluded ones — check `autoApplyListed`). */
  get autoApplyToolkits(): string[] {
    return [...this.#autoApply];
  }
}

/** Resolve optional admin lists into a policy; omitted lists mean empty. */
export function resolveToolkitPolicy(
  p?: { excludedToolkits: string[]; autoApplyToolkits: string[] },
): ToolkitPolicy {
  return new ToolkitPolicy(p?.excludedToolkits ?? [], p?.autoApplyToolkits ?? []);
}

/** Whether the tool's tags affirmatively include a create/update-family hint. */
function hasWriteHint(tags: ReadonlySet<string>): boolean {
  return tags.has("createHint") || tags.has("updateHint");
}

/**
 * Auto-apply eligibility: adminListed && write-classified && tags affirmatively include
 * `createHint` or `updateHint` AND do not include `destructiveHint`. Composio's silence never
 * enables anything, and the absence of `destructiveHint` alone never suffices — tags are
 * third-party metadata (possibly inferred from an MCP server's own hints), so an injected
 * `destructiveHint: false` must not be able to arm a write.
 */
export function isAutoApplyEligible(
  policy: ToolkitPolicy,
  toolkitSlug: string,
  tool: { tags?: string[]; readOnly?: boolean },
): boolean {
  if (!policy.autoApplyListed(toolkitSlug)) return false;
  if (tool.readOnly) return false;
  const tags = new Set(tool.tags ?? []);
  return hasWriteHint(tags) && !tags.has("destructiveHint");
}

/** The per-toolkit auto-apply action kind: "all current and future write tools in this toolkit". */
export function toolkitWriteActionKind(slug: string): { tag: `composio:${string}:write` } {
  return { tag: `composio:${slug}:write` };
}

/** The never-armable kind every `input_required` continuation is staged under. */
export const CONTINUATION_ACTION_KIND = { tag: "composio-continue" } as const;
