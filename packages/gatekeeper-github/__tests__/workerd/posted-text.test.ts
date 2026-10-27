// The text apply posts, end to end through the real `GitHubGatekeeperImpl` Durable Object
// (driven via the TestHooks facet, GitHub faked at the `fetch` boundary): `#~N` provisional
// references become the GitHub numbers their creates landed as, slash-command lines are escaped
// so GitHub cannot run them, and a dispatching action never posts an unresolved reference.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { GatekeeperProps, Outcome } from "./worker";

const OWNER = "acme";
const REPO = "widgets";
const API_BASE = `https://api.github.com/repos/${OWNER}/${REPO}`;

/** Captured request bodies, keyed by the REST endpoints this flow touches. */
class FakeGitHub {
  readonly createdIssues: { title: string, body?: string }[] = [];
  readonly postedComments = new Map<number, string[]>();

  install(): void {
    vi.stubGlobal("fetch", this.#handle.bind(this));
  }

  async #handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : (input as Request).url ?? String(input));
    const path = url.origin + url.pathname;
    const body = init?.body === undefined ? undefined : await new Response(init.body).text();

    if (path === `${API_BASE}/issues` && init?.method === "POST") {
      this.createdIssues.push(JSON.parse(body!));
      return Response.json({
        number: 12, id: 12, html_url: `https://github.com/${OWNER}/${REPO}/issues/12`,
        title: "Bug", state: "open", user: null, labels: [], created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z", comments: 0,
      });
    }

    const commentMatch = path.match(new RegExp(`^${API_BASE}/issues/(\\d+)/comments$`));
    if (commentMatch && init?.method === "POST") {
      const issue = Number(commentMatch[1]);
      const posted = this.postedComments.get(issue) ?? [];
      posted.push(JSON.parse(body!).body);
      this.postedComments.set(issue, posted);
      return Response.json({
        id: 101, html_url: `https://github.com/${OWNER}/${REPO}/issues/12#issuecomment-101`,
        user: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
        body: JSON.parse(body!).body,
      });
    }

    throw new Error(`test: unexpected fetch to ${url}`);
  }
}

/** Stands in for the workspace git cache; no text action touches it, but apply takes the stub. */
class NullGitCache extends RpcTarget {
  async isAncestor(): Promise<boolean> {
    throw new Error("test: git ancestry is not part of this flow");
  }

  async get(): Promise<null> {
    return null;
  }

  async buildPack(): Promise<ReadableStream> {
    throw new Error("test: pack building is not part of this flow");
  }
}

/** Records what the gatekeeper submits, standing in for the overseer's approval queue. */
class TestApprovalQueue extends RpcTarget {
  async submitAction(_action: number, _description: ActionDescription): Promise<void> {}
}

let nextScenario = 0;
let nextApprovalId = 1;

function stubOf(target: TestApprovalQueue | NullGitCache): never {
  // Fresh stubs per call: a stub passed as an RPC argument is disposed when the call returns.
  return new RpcStub(target) as never;
}

async function unwrap<T>(pending: Promise<Outcome<T>>): Promise<T> {
  const result = await pending;
  if ("error" in result) throw new Error(result.error);
  return result.ok;
}

async function repoGatekeeper() {
  const scenario = `posted-text-${nextScenario++}`;
  const accountId = env.USER_ACCOUNT.newUniqueId();
  await runInDurableObject(env.USER_ACCOUNT.get(accountId), async (_instance, state) => {
    state.storage.kv.put("accessToken", "test-token");
  });
  const props: GatekeeperProps = {
    userObjectId: accountId.toString(),
    resourceKind: "repo",
    owner: OWNER,
    repo: REPO,
  };
  const hooks = env.TEST_HOOKS.getByName(scenario);
  const submit = (action: object) => {
    const approvalId = nextApprovalId++;
    return unwrap(hooks.submitAction(scenario, props, stubOf(new TestApprovalQueue()),
      { approvalId, submittedAt: 0, owner: OWNER, repo: REPO, ...action } as never,
      { title: "test", description: "test", implementsRevert: false })).then(() => approvalId);
  };
  return {
    submit,
    apply: (actionId: number) =>
      unwrap(hooks.applyAction(scenario, props, actionId, stubOf(new NullGitCache()))),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("posted text", () => {
  it("rewrites #~N to the created number and escapes slash-command lines", async () => {
    const github = new FakeGitHub();
    github.install();
    const gk = await repoGatekeeper();

    const create = await gk.submit({ type: "createIssue", provisionalId: "~1", options: { title: "Bug" } });
    const comment = await gk.submit({
      type: "postComment", targetKind: "issue", targetId: "~1", provisionalCommentId: "~comment1",
      bodyMarkdown: "/close\nFixes #~1.\nSee /close mid-sentence.",
    });

    await gk.apply(create);
    expect(github.createdIssues).toEqual([{ title: "Bug" }]);

    await gk.apply(comment);
    // ~1 landed as number 12, so the reference rewrites; the leading /close line is escaped, and
    // the mid-sentence one (which GitHub would not run) is left exactly as written.
    expect(github.postedComments.get(12)).toEqual([
      "\\/close\nFixes #12.\nSee /close mid-sentence.",
    ]);
  });

  it("refuses to dispatch a comment naming a provisional that never landed", async () => {
    const github = new FakeGitHub();
    github.install();
    const gk = await repoGatekeeper();

    const comment = await gk.submit({
      type: "postComment", targetKind: "issue", targetId: "~9", provisionalCommentId: "~comment1",
      bodyMarkdown: "Fixes #~9",
    });

    await expect(gk.apply(comment)).rejects.toThrow(/has not been created on GitHub yet/);
    expect(github.postedComments.size).toBe(0);
  });
});
