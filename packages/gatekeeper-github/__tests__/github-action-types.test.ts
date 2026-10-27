// GitHub may run a line of posted Markdown that starts with `/name` as a slash command on the
// issue or pull request, whatever the approved action said; every text this gatekeeper posts is
// escaped so that no such line runs. Also: the `#~N` provisional reference is matched as a whole
// token only, and the target/vocabulary helpers the queue and reject cascade read.

import { describe, expect, it } from "vitest";
import {
  actionTarget, escapeQuickActions, PROVISIONAL_REFERENCE, referenceBearingTexts, textReferences,
  type GitHubAction,
} from "../src/github-action-types";

describe("escapeQuickActions", () => {
  it("escapes every line GitHub would run, on any line of the text", () => {
    expect(escapeQuickActions("/close")).toBe("\\/close");
    expect(escapeQuickActions("Done.\n/lock\nThanks")).toBe("Done.\n\\/lock\nThanks");
    expect(escapeQuickActions("/assign @reviewer")).toBe("\\/assign @reviewer");
    // A carriage return before the name is treated as if GitHub had deleted it, so the escape
    // stays ahead of any newline normalization between the writer and the extractor.
    expect(escapeQuickActions("Done.\r\n/close\r\n")).toBe("Done.\r\n\\/close\r\n");
  });

  it("leaves lines GitHub would not run, so paths and already-escaped text read unchanged", () => {
    for (const text of ["see /close", " /close", "/usr/bin/env node", "/", "\\/close"]) {
      expect(escapeQuickActions(text)).toBe(text);
    }
  });
});

describe("PROVISIONAL_REFERENCE", () => {
  it("matches a provisional reference only as a whole token", () => {
    expect(textReferences("Fixes #~1", "~1")).toBe(true);
    expect(textReferences("#~1 and #~2", "~2")).toBe(true);
    // #~10 is its own reference: #~1 inside it must not read (nor rewrite) as the number 1.
    expect(textReferences("Fixes #~10", "~1")).toBe(false);
    expect(textReferences("See #~1a", "~1")).toBe(false);
    expect(textReferences("plain 1 text", "~1")).toBe(false);
  });

  it("rewrites whole tokens only, so a longer reference keeps its number", () => {
    expect("Fixes #~10 and #~2".replace(PROVISIONAL_REFERENCE, () => "#42"))
      .toBe("Fixes #42 and #42");
    // A trailing word character means the token is not a reference at all: the old loose pattern
    // /#(~\d+)/g matched #~1 inside #~1a and would have rewritten it to #42a.
    expect("See #~1a".replace(PROVISIONAL_REFERENCE, () => "#42")).toBe("See #~1a");
    expect("Fixes #~10 and #~2.".replace(PROVISIONAL_REFERENCE, () => "#42"))
      .toBe("Fixes #42 and #42.");
  });
});

const base = { approvalId: 1, submittedAt: 0, owner: "acme", repo: "widgets" };
const entity = { ...base, targetKind: "issue" as const, targetId: "~1" };

describe("referenceBearingTexts", () => {
  it("names every Markdown field apply posts, and nothing else", () => {
    const review = (bodyMarkdown?: string, diffComments?: { bodyMarkdown: string }[]) =>
      ({ ...base, type: "postReview", pullId: "7", provisionalReviewId: "~r1",
        review: { revision: { baseSha: "a", headSha: "b" }, decision: "comment" as const,
          bodyMarkdown, diffComments } }) as unknown as GitHubAction;
    expect(referenceBearingTexts({ ...base, type: "createIssue", provisionalId: "~1",
      options: { title: "t", bodyMarkdown: "b" } })).toEqual(["b"]);
    expect(referenceBearingTexts({ ...base, type: "createIssue", provisionalId: "~1",
      options: { title: "t" } })).toEqual([]);
    expect(referenceBearingTexts({ ...base, type: "createPullRequest", provisionalId: "~1",
      options: { title: "t", head: "h", base: "m", bodyMarkdown: "b" } })).toEqual(["b"]);
    expect(referenceBearingTexts({ ...entity, type: "setBody", bodyMarkdown: "b",
      previousBodyMarkdown: "p" })).toEqual(["b"]);
    expect(referenceBearingTexts({ ...entity, type: "postComment", bodyMarkdown: "c",
      provisionalCommentId: "~c1" })).toEqual(["c"]);
    expect(referenceBearingTexts(review("rb", [{ bodyMarkdown: "d1" }, { bodyMarkdown: "d2" }])))
      .toEqual(["rb", "d1", "d2"]);
    expect(referenceBearingTexts({ ...base, type: "mergePullRequest", pullId: "7",
      expectedHeadSha: "b", headBranch: "f" })).toEqual([]);
    expect(referenceBearingTexts({ ...base, type: "push", branch: "main",
      expectedOldSha: "a", newSha: "b", force: false })).toEqual([]);
  });
});

describe("actionTarget", () => {
  it("reads the issue or pull an action targets, kind by kind", () => {
    expect(actionTarget({ ...entity, type: "setTitle", title: "t", previousTitle: "p" }))
      .toEqual({ kind: "issue", id: "~1" });
    expect(actionTarget({ ...base, type: "postReview", pullId: "~2", provisionalReviewId: "~r1",
      review: { revision: { baseSha: "a", headSha: "b" }, decision: "comment" } }))
      .toEqual({ kind: "pull", id: "~2" });
    expect(actionTarget({ ...base, type: "mergePullRequest", pullId: "7",
      expectedHeadSha: "b", headBranch: "f" })).toEqual({ kind: "pull", id: "7" });
    expect(actionTarget({ ...base, type: "replyToDiffComment", pullId: "7", commentId: "9",
      bodyMarkdown: "r", provisionalCommentId: "~c1" })).toEqual({ kind: "pull", id: "7" });
    // Creates target their own provisional; pushes target a branch, never an issue or pull.
    expect(actionTarget({ ...base, type: "createIssue", provisionalId: "~1", options: { title: "t" } }))
      .toBeUndefined();
    expect(actionTarget({ ...base, type: "push", branch: "main", expectedOldSha: "a",
      newSha: "b", force: false })).toBeUndefined();
  });
});
