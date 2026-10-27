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
import {
  escapeQuickActions,
  PROVISIONAL_REFERENCE,
  referenceBearingTexts,
  type GitHubAction,
  type RemoveLabelsAction,
} from "./github-action-types";

// Apply posts every text `referenceBearingTexts` names with `#~N` replaced by the GitHub number
// of the issue or pull request created in this workspace as `~N`, and with slash-command lines
// escaped. The card shows the text as the agent wrote it and tells the approver of each.
function noteTextRewrites(builder: ActionDescriptionBuilder, action: GitHubAction): ActionDescriptionBuilder {
  const texts = referenceBearingTexts(action);
  if (texts.some(text => text.replace(PROVISIONAL_REFERENCE, "") !== text)) {
    builder.prose(
      "References like #~N to issues or pull requests created in this workspace are replaced " +
      "with their GitHub numbers when applied.");
  }
  if (texts.some(text => escapeQuickActions(text) !== text)) {
    builder.prose(
      "Lines like /close are posted with a backslash before the slash, so GitHub does not run them " +
      "as slash commands; the backslash shows inside code blocks.");
  }
  return builder;
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
      return noteTextRewrites(buildDescription(`Create a new issue in ${repo}.`)
        .inline("Provisional ID", action.provisionalId)
        .inline("Title", options.title)
        .verbatim("Body", options.bodyMarkdown ?? "", "markdown")
        .list("Labels", options.labels ?? [])
        .list("Assignees", options.assignees ?? []), action)
        .finish();
    }
    case "createPullRequest": {
      const { options } = action;
      return noteTextRewrites(buildDescription(
        `Create a new ${options.draft ? "draft " : ""}pull request in ${repo}.`)
        .inline("Provisional ID", action.provisionalId)
        .inline("Title", options.title)
        .inline("Head branch", options.head)
        .inline("Base branch", options.base)
        .verbatim("Body", options.bodyMarkdown ?? "", "markdown"), action)
        .finish();
    }
    case "setTitle":
      return buildDescription(`Change the title of #${action.targetId}.`)
        .inline("Current title", action.previousTitle)
        .inline("New title", action.title)
        .finish();
    case "setBody":
      return noteTextRewrites(
        buildDescription(`Replace the Markdown body of #${action.targetId}.`)
          .verbatim("New body", action.bodyMarkdown, "markdown"), action)
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
      return noteTextRewrites(
        buildDescription(`Post a new Markdown comment on #${action.targetId}.`)
          .verbatim("Comment", action.bodyMarkdown, "markdown"), action)
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
      return noteTextRewrites(builder, action).finish();
    }
    case "replyToDiffComment":
      return noteTextRewrites(
        buildDescription(`Reply to a diff discussion thread on pull request #${action.pullId}.`)
          .inline("Thread", action.commentId)
          .inline("Provisional ID", action.provisionalCommentId)
          .verbatim("Reply", action.bodyMarkdown, "markdown"), action)
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
