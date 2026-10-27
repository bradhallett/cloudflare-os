// The approver-facing descriptions of the GitHub gatekeeper's queued actions, and the
// provisional-reference note they carry. Same shape as gatekeeper-gitlab's
// gitlab-descriptions.ts.

import {
  ActionDescriptionBuilder,
  buildDescription,
  codeSpan,
  type RenderedDescription,
} from "@gadgets/gatekeeper-kit/action-description";
import { ZERO_OID } from "@gadgets/gatekeeper-kit/git-transport";
import type {
  GitHubAction,
  RemoveLabelsAction,
} from "./github-action-types";

/**
 * Apply replaces `#~N` in a Markdown body with the GitHub number of the issue or pull request
 * created in this workspace as `~N`. Both name the same thing, so the body shown stays the body
 * sent, but the approver is told the number will change.
 */
export const PROVISIONAL_REFERENCE = /#~\d+/;

export function noteReferenceRewrite(builder: ActionDescriptionBuilder, ...bodies: (string | undefined)[]):
    ActionDescriptionBuilder {
  return bodies.some(body => body !== undefined && PROVISIONAL_REFERENCE.test(body))
    ? builder.prose(
      "References like #~N to issues or pull requests created in this workspace are replaced " +
      "with their GitHub numbers when applied.")
    : builder;
}

/**
 * The label set a `removeLabels` apply writes with `setLabels`: the labels staged in
 * `previousLabels` minus the removed ones, compared case-insensitively.
 */
export function remainingLabels(action: RemoveLabelsAction): string[] {
  return action.previousLabels.filter(
    label => !action.labels.some(removed => removed.toLowerCase() === label.toLowerCase()));
}

/**
 * The approver-facing text for a staged action, rendered from the payload that will be applied so
 * every body, title, label and commit message the agent wrote is there to read in full. A push is
 * the one action whose content (git objects) cannot be shown as text, so its description is a
 * summary and never claims to be complete. Prose interpolates only the gatekeeper's logical ids
 * and the bound repository; agent arguments, enums included, sit in fields or code spans.
 */
export function describeGitHubAction(action: GitHubAction): RenderedDescription {
  const repo = `${action.owner}/${action.repo}`;
  switch (action.type) {
    case "createIssue": {
      const { options } = action;
      return noteReferenceRewrite(buildDescription(`Create a new issue in ${repo}.`)
        .inline("Provisional ID", action.provisionalId)
        .inline("Title", options.title)
        .verbatim("Body", options.bodyMarkdown ?? "", "markdown")
        .list("Labels", options.labels ?? [])
        .list("Assignees", options.assignees ?? []), options.bodyMarkdown)
        .finish();
    }
    case "createPullRequest": {
      const { options } = action;
      return noteReferenceRewrite(buildDescription(
        `Create a new ${options.draft ? "draft " : ""}pull request in ${repo}.`)
        .inline("Provisional ID", action.provisionalId)
        .inline("Title", options.title)
        .inline("Head branch", options.head)
        .inline("Base branch", options.base)
        .verbatim("Body", options.bodyMarkdown ?? "", "markdown"), options.bodyMarkdown)
        .finish();
    }
    case "setTitle":
      return buildDescription(`Change the title of #${action.targetId}.`)
        .inline("Current title", action.previousTitle)
        .inline("New title", action.title)
        .finish();
    case "setBody":
      return noteReferenceRewrite(
        buildDescription(`Replace the Markdown body of #${action.targetId}.`)
          .verbatim("New body", action.bodyMarkdown, "markdown"), action.bodyMarkdown)
        .finish();
    case "addLabels":
      return buildDescription(`Add labels to #${action.targetId}.`)
        .list("Labels", action.labels)
        .finish();
    case "removeLabels":
      return buildDescription(
        `Remove labels from #${action.targetId} by replacing its labels with the resulting set ` +
        "below, computed from its labels when this was staged. Any label added after this was " +
        "staged is removed too, and any other label removed since is added back.")
        .list("Remove", action.labels)
        .list("Resulting labels", remainingLabels(action))
        .finish();
    case "changeState": {
      if (action.state !== "closed") {
        return buildDescription(`Reopen #${action.targetId}.`).finish();
      }
      const builder = buildDescription(`Close #${action.targetId}.`);
      if (action.reason) builder.inline("Reason", action.reason);
      return builder.finish();
    }
    case "postComment":
      return noteReferenceRewrite(
        buildDescription(`Post a new Markdown comment on #${action.targetId}.`)
          .verbatim("Comment", action.bodyMarkdown, "markdown"), action.bodyMarkdown)
        .finish();
    case "postReview": {
      const { review } = action;
      const builder = buildDescription(`Submit a review for pull request #${action.pullId}.`)
        .inline("Decision", review.decision)
        .inline("Reviewed head", review.revision.headSha)
        .verbatim("Body", review.bodyMarkdown ?? "", "markdown");
      for (const [index, comment] of (review.diffComments ?? []).entries()) {
        const { target } = comment;
        // Every coordinate apply sends: a multi-line range carries its own start side.
        const where = target.subjectType === "file"
          ? `${target.path} (whole file)`
          : `${target.path}:${target.startLine !== undefined
            ? `${target.startLine}${target.startSide ? ` (${target.startSide})` : ""}-`
            : ""}${target.line} (${target.side})`;
        builder
          .inline(`Diff comment ${index + 1} on`, where)
          .inline(`Diff comment ${index + 1} provisional ID`, comment.provisionalCommentId)
          .verbatim(`Diff comment ${index + 1}`, comment.bodyMarkdown, "markdown");
      }
      return noteReferenceRewrite(builder, review.bodyMarkdown,
        ...(review.diffComments ?? []).map(comment => comment.bodyMarkdown)).finish();
    }
    case "replyToDiffComment":
      return noteReferenceRewrite(
        buildDescription(`Reply to a diff discussion thread on pull request #${action.pullId}.`)
          .inline("Thread", action.commentId)
          .inline("Provisional ID", action.provisionalCommentId)
          .verbatim("Reply", action.bodyMarkdown, "markdown"), action.bodyMarkdown)
        .finish();
    case "mergePullRequest": {
      const options = action.options ?? {};
      const builder = buildDescription(`Merge pull request #${action.pullId}.`)
        .inline("Head commit", action.expectedHeadSha);
      if (options.method !== undefined) builder.inline("Method", options.method);
      if (options.commitTitle !== undefined) builder.verbatim("Commit title", options.commitTitle);
      if (options.commitMessage !== undefined) {
        builder.verbatim("Commit message", options.commitMessage);
      }
      return builder.finish();
    }
    case "push": {
      const creating = action.expectedOldSha === ZERO_OID;
      const description = creating
        ? `Push commit ${codeSpan(action.newSha)} to ${repo}, ` +
          `creating branch ${codeSpan(action.branch)}.`
        : `Push commit ${codeSpan(action.newSha)} to branch ${codeSpan(action.branch)} of ${repo}, ` +
          `moving the branch from its current head ${codeSpan(action.expectedOldSha)}.` +
          (action.force ? " This is a force push: it rewrites the branch's history." : "");
      // The commits themselves cannot be reviewed as text here, so no completeness claim.
      return { description };
    }
  }
}
