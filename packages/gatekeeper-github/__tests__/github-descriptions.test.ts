// The approval cards whose text binds what the approver agrees to: a comment says that its
// slash-command lines will not run and its `#~N` references will be rewritten to GitHub numbers,
// and says nothing of either when the posted text needs no rewrite.

import { describe, expect, it } from "vitest";
import { describeGitHubAction } from "../src/github-descriptions";

const BASE = { approvalId: 1, submittedAt: 0, owner: "acme", repo: "widgets" };
const COMMENT = { ...BASE, type: "postComment", targetKind: "issue" as const, targetId: "7", provisionalCommentId: "~comment1" } as const;

describe("comment card", () => {
  it("shows the comment as written and warns that escaped lines carry a backslash code blocks show", () => {
    // GitHub would never run a line inside a fence, but it is escaped anyway, so it posts changed.
    const body = "Try this:\n```\n/close\n```";
    const card = describeGitHubAction({ ...COMMENT, bodyMarkdown: body });
    expect(card.fields).toEqual([expect.objectContaining({ label: "Comment", value: body })]);
    expect(card.description).toMatch(/backslash/);
    expect(card.description).toMatch(/code block/);
  });

  it("warns that provisional references become GitHub numbers when applied", () => {
    const card = describeGitHubAction({ ...COMMENT, bodyMarkdown: "Fixes #~1" });
    expect(card.fields).toEqual([
      expect.objectContaining({ label: "Comment", value: "Fixes #~1" }),
    ]);
    expect(card.description).toMatch(/replaced with their GitHub numbers/);
  });

  it("says nothing of rewrites when no line would run and no reference is provisional", () => {
    const card = describeGitHubAction({ ...COMMENT, bodyMarkdown: "see /close and #12" });
    expect(card.description).not.toMatch(/backslash/);
    expect(card.description).not.toMatch(/replaced/);
  });
});
