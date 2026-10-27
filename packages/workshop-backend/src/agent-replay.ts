// =======================================================================================
// The replay interpreter for the agent loop, extracted from agent.ts: the code that rebuilds
// the model-message sequence from a chat's stored history before the model is first prompted.
// Stored assistant turns are rehydrated verbatim (tool calls and their outputs included);
// every other history record -- user messages, changes, merges, reverts, connection requests
// and the rest -- is rendered as the observation the model would have seen had it been
// present; and the session's replay bookkeeping (read-file tracking, pending replay edits,
// change ids, message status) is kept up along the way. The live loop (runAgentPass) stays in
// agent.ts and calls replayChatLog() before its first model request.

import { WorkpieceId, AiToolCall, AiChatMessage, BlueprintMerge, ChatGadgetPinRecord, MainlineMergeGadget } from '@gadgets/workshop-shared/api';
import { PDF_MIME_TYPE, modelApiSupportsPdfAttachments } from './chat-attachment-pdf';
import { canInlineChatAttachmentImage, decodeChatAttachmentText, isAllowedChatAttachmentImageMimeType } from './chat-attachment-validation';
import { createWorkshopLogger } from "./observability";
import { OBSERVE_USER_CHANGES_NOOP_RESULT, formatMissingBlueprintBindings } from "./agent-prompt";
import { applyPendingEditToText, makeReplayAssistantMessage, makeReplayObservation } from "./agent-session";
import { foldProposedChanges } from "./agent-compaction";
import { readFileWindow, jsonToolResultText } from "./agent-tools";
import { applyMessageBindings } from "./project-chat-log";
import type{
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import type{ TurnSession } from "./agent-session";
import type{ AgentHooks, ChatHistory } from "./agent-hooks";
import type{ StoredAssistantMessage } from "./storage-schema/overseer-storage";
import type{ ModelHandle } from "./ai-models";

const logger = createWorkshopLogger("workshop.agent");


// How many files each list in the agent's summary of a merge, of a blueprint or from mainline,
// names before it counts the rest instead, so that a merge of very many files cannot fill the
// context with paths.
const MERGE_SUMMARY_PATH_LIMIT = 50;

// One list of files in such a summary: nothing if there are none, else the heading and the
// paths. The paths are quoted because someone else chose them, such as a blueprint's author.
function formatMergedPaths(heading: string, paths: string[]): string[] {
  if (paths.length === 0) return [];
  let lines = paths.slice(0, MERGE_SUMMARY_PATH_LIMIT).map(path => `* ${JSON.stringify(path)}`);
  if (paths.length > lines.length) lines.push(`* (and ${paths.length - lines.length} more)`);
  return ["", heading, ...lines];
}

/**
 * The files that a three-way merge changed and did not report as conflicted, by whether the
 * side the files were merged into had changes of its own to them. `base` is the commit the two
 * sides have in common, `incoming` the side merged in, and `own` the side merged into. A file is
 * listed if it differs between `base` and `incoming` and between `own` and `incoming`, so a file
 * that both sides changed alike is not. Compares trees by id, so no file is read.
 */
async function classifyMergedPaths(
    hooks: Pick<AgentHooks, "listChangedPaths">,
    sides: {base: string, incoming: string, own: string}, conflictPaths: string[])
    : Promise<{bothChanged: string[], incomingChanged: string[]}> {
  let [incomingChanges, ownToIncoming, ownChanges] = await Promise.all([
    hooks.listChangedPaths(sides.base, sides.incoming),
    hooks.listChangedPaths(sides.own, sides.incoming),
    hooks.listChangedPaths(sides.base, sides.own),
  ]);
  let differs = new Set(ownToIncoming);
  let changedByOwn = new Set(ownChanges);
  let conflicted = new Set(conflictPaths);
  let bothChanged: string[] = [];
  let incomingChanged: string[] = [];
  for (let path of incomingChanges) {
    if (!differs.has(path) || conflicted.has(path)) continue;
    (changedByOwn.has(path) ? bothChanged : incomingChanged).push(path);
  }
  return {bothChanged, incomingChanged};
}

// The opening of the agent's summary of an update from mainline, before each gadget's part.
const MAINLINE_MERGE_INTRO =
    `The user updated this chat with the changes accepted from other chats since it was last ` +
    `brought up to date.`;

/**
 * Renders one gadget's part of an update from mainline (see Overseer.updateChatFromMainline())
 * for the model, which sees it as an observation of the user's changes, after
 * MAINLINE_MERGE_INTRO. `entry` is the gadget's part of the message's record, `declaration` the
 * message's pin declaration for it, and `gadget` its name in the chat's env. `forgotten` names
 * the files the model had read whose text the update changed (see applyReplayedPin), which it
 * must read again: readFile promises to say when that happens.
 *
 * The update merged the chat's files with mainline, so its diff could be as large as everything
 * the other chats changed. The summary names the commits of the merge instead, with a way to
 * diff any two, and lists the files by what the merge did with them. Its size does not depend on
 * what is in the files. It sets no task: the chat is the user's.
 */
async function formatMainlineMerge(
    entry: MainlineMergeGadget, declaration: ChatGadgetPinRecord, gadget: string,
    forgotten: string[], hooks: Pick<AgentHooks, "listChangedPaths">): Promise<string> {
  let mainline = declaration.mergedCommit ?? declaration.baseCommit;
  let {bothChanged, incomingChanged} = await classifyMergedPaths(hooks,
      {base: entry.baseCommit, incoming: mainline, own: entry.chatCommit}, entry.conflictPaths);
  let lines = [
    `The files of \`env.${gadget}\` in this chat are now the result of a three-way merge.`,
    ``,
    `The commits that were merged, and the result:`,
    `* merged base, the version this chat was last based on: ${entry.baseCommit}`,
    `* mainline, with the other chats' changes: ${mainline}`,
    `* this chat, before the update: ${entry.chatCommit}`,
    `* the result, which this chat's files now start from: ${declaration.baseCommit}`,
    ``,
    `To see what changed from one commit to another, run in \`executeCode\`:`,
    `  (await env.GIT.newWorktree("<to>")).diff("<from>")`,
    `From merged base to mainline is what the other chats changed. From this chat before the ` +
        `update to the result is what the update did to this chat's files.`,
    ...formatMergedPaths(`Files with conflicts:`, entry.conflictPaths),
  ];
  if (entry.conflictPaths.length > 0) {
    lines.push(
        `A file listed as conflicted that has no markers in it was deleted on one side and ` +
        `changed on the other: it holds the changed version.`);
  }
  lines.push(
      ...formatMergedPaths(
          `Files that this chat and mainline both changed, merged with no conflict found:`,
          bothChanged),
      ...formatMergedPaths(`Files that only mainline changed:`, incomingChanged));
  if (forgotten.length > 0) {
    // Not capped like the lists above: the model read every one of these itself.
    lines.push(``,
        `Files you read earlier that the update changed, which you must read again before ` +
            `editing them:`,
        ...forgotten.map(path => `* ${JSON.stringify(path)}`));
  }
  return lines.join("\n");
}

/**
 * Renders a blueprint that the user applied to a gadget (see GadgetClient.applyBlueprint()) as
 * the model's input, from the record of the proposal and the "changes" message `msg` that
 * carries it. `gadget` is the gadget's name in the chat's env, if it has one.
 *
 * A merge is rendered for review: a summary of it and the task of checking it. That is what
 * prompts the turn applyBlueprint() starts, which has no message to answer. The merge is a
 * commit, whose diff could be as large as everything the blueprint changed. So the summary
 * names the commits of the merge instead, with a way to diff any two, and lists the files by
 * what the merge did with them. Its size does not depend on what is in the files.
 *
 * Any other proposal left the agent nothing to check. It is rendered as a note of what
 * happened, for a later turn in the chat to know of.
 */
async function formatBlueprintProposal(
    merge: BlueprintMerge, msg: Pick<Extract<AiChatMessage, {type: "changes"}>, "pins">,
    gadget: string | undefined, hooks: Pick<AgentHooks, "listChangedPaths">): Promise<string> {
  let applied = `The user applied version ${merge.version} of the blueprint ` +
      `${JSON.stringify(merge.title)} to ` +
      (gadget !== undefined ? `the gadget \`env.${gadget}\`` : `a gadget`) +
      `, as a proposed change in this chat.`;
  if (merge.kind === "follow") {
    return `${applied} None of the gadget's files change: accepting it only has the gadget ` +
        `take its future updates from that blueprint.`;
  }
  if (merge.kind === "fastForward") {
    return `${applied} The gadget had no changes of its own to keep, so its files are now ` +
        `that version's exactly.`;
  }

  // A merge is always recorded with its base, on the message that re-roots the gadget at the
  // merge commit, whose `mergedCommit` is the head it merged into (see applyBlueprint in
  // overseer.ts).
  let base = merge.baseCommit!;
  let declaration = msg.pins!.find(pin => pin.gadgetId === merge.gadgetId)!;
  let head = declaration.mergedCommit ?? declaration.baseCommit;
  let {bothChanged, incomingChanged: blueprintChanged} = await classifyMergedPaths(hooks,
      {base, incoming: merge.commitId, own: head}, merge.conflictPaths);

  let lines = [
    `${applied} The gadget has changes of its own, so the blueprint's changes were merged ` +
        `with them, three ways. The gadget's files in this chat are now the result.`,
    ``,
    `The commits that were merged, and the result:`,
    `* base, the version the two have in common: ${base}`,
    `* this gadget, before the merge: ${head}`,
    `* blueprint: ${merge.commitId}`,
    `* the result, which the gadget's files in this chat start from: ${declaration.baseCommit}`,
    ``,
    `To see what changed from one commit to another, run in \`executeCode\`:`,
    `  (await env.GIT.newWorktree("<to>")).diff("<from>")`,
    `From base to blueprint is what the blueprint changed. From this gadget before the merge ` +
        `to the result is what the merge did to the gadget's files. To read a commit's files ` +
        `with \`readFile\` and \`grep\`, mount it with \`createWorktree\`.`,
  ];
  if (merge.unverifiedBase) {
    lines.push(``,
        `The gadget and the blueprint share no history, so that base is a guess at what the ` +
        `gadget was built from. A change that the gadget's owner made, if the guess happens ` +
        `to include it, looks like something the blueprint removed: the merge undid it and ` +
        `reported no conflict. Compare the gadget before the merge with the result, and ` +
        `tell the user of anything lost that looks like their own work.`);
  }
  lines.push(
      ...formatMergedPaths(`Files with conflicts:`, merge.conflictPaths),
      ...formatMergedPaths(
          `Files that the gadget and the blueprint both changed, merged with no conflict found:`,
          bothChanged),
      ...formatMergedPaths(`Files that only the blueprint changed:`, blueprintChanged));
  if (merge.missingBindings) {
    lines.push(``, formatMissingBlueprintBindings(merge.missingBindings, `the gadget`));
  }

  lines.push(``, `Review the merge now, without waiting to be asked:`);
  if (merge.conflictPaths.length > 0) {
    lines.push(
        `* Resolve every conflict. A file listed as conflicted that has no markers in it was ` +
        `deleted by one side and changed by the other: it holds the changed version, and ` +
        `whether it should stay is yours to decide.`);
  }
  lines.push(
      `* Check that the gadget's own changes and the blueprint's still work together, ` +
      `starting with any files that both changed. Changes that merge cleanly can still ` +
      `disagree, as when one side renames something that the other side's new code uses.`);
  if (merge.missingBindings) lines.push(`* Wire up the bindings listed above.`);
  lines.push(
      `Change nothing else: the user asked for the update, not for other improvements. When ` +
      `you are done, tell the user briefly what the update changed and what you did.`);
  return lines.join("\n");
}


// =======================================================================================

/**
 * Rebuilds the model-facing assistant message for one agent step from its persisted snapshot,
 * verbatim except that each tool-call block's arguments are rehydrated from the step's AiToolCall
 * record (see StoredToolCall). Returns undefined -- the caller then falls back to reconstructing
 * the message from the display record -- if a block references a tool call the display record
 * doesn't have, which indicates a bug (the two are written together) or corrupted storage.
 * (Exported for tests.)
 */
export function rehydrateStoredAssistantMessage(
    stored: StoredAssistantMessage, toolCalls: AiToolCall[] | undefined,
    chatId: number, sequence: number): AssistantMessage | undefined {
  let toolCallsById = new Map((toolCalls ?? []).map(tc => [tc.toolCallId, tc]));
  let content: AssistantMessage["content"] = [];
  for (let block of stored.content) {
    if (block.type !== "toolCall") {
      content.push(block);
      continue;
    }
    let record = toolCallsById.get(block.id);
    if (!record) {
      logger.error("stored assistant message references unknown tool call", {
        event: "agent.model.data.rehydrate.failed",
        chatId, sequence, toolCallId: block.id,
      });
      return undefined;
    }
    content.push({...block, arguments: record.input as ToolCall["arguments"]});
  }
  return {...stored, content};
}


// =======================================================================================

/**
 * Replays the chat's stored history (`chatMessages`, oldest first) into the session's
 * model-message sequence, reconstructing what the model would have seen had it been present
 * for the whole conversation: user messages become user turns, stored assistant messages are
 * rehydrated (tool calls and outputs included), and every other history record becomes an
 * observation. Also keeps up the session's replay bookkeeping -- read-file tracking, pending
 * replay edits, change ids, chat-message status. `checkpoint`, when non-null, is the chat's
 * compaction checkpoint; the revert case uses its `compactedTo` boundary to tell a revert that
 * reached into the summarized turns from one whose discarded changes it can name. Called once
 * per agent pass, before the first model request.
 */
export async function replayChatLog(
    {session, hooks, handle, chatId, chatMessages, checkpoint}: {
      session: TurnSession;
      hooks: AgentHooks;
      handle: ModelHandle;
      chatId: number;
      chatMessages: ChatHistory["chatMessages"];
      checkpoint: ChatHistory["checkpoint"];
    }): Promise<void> {
  // Count across the whole replay, not just the latest upload batch. PDFs also count on some
  // providers; conservatively include candidate parts even if their headers later rule them out.
  const attachmentImageCount = chatMessages.reduce((count, msg) => count + (msg.type === "message"
    ? msg.attachments?.filter(attachment => isAllowedChatAttachmentImageMimeType(attachment.mimeType) ||
        (attachment.mimeType === PDF_MIME_TYPE && modelApiSupportsPdfAttachments(handle.model.api))).length ?? 0
    : 0), 0);
  const attachmentImageMaxEdge = attachmentImageCount > 20 ? 2000 : 8000;
  for (let [msgIndex, msg] of chatMessages.entries()) {
    let modelMessageStart = session.modelMessages.length;
    let msgTimestamp = msg.timestamp.getTime();
    // Fold this message's binding effects in first, through the shared walk (see
    // project-chat-log.ts), so every rendering below -- diff headings, links, descriptions --
    // sees the scope as of this point in the log. The message's own binding mutations used to
    // be inlined per case below; they are one walk now.
    applyMessageBindings(session.chatScope, msg);
    switch (msg.type) {
      case "message": {
        let content = msg.message;

        if (msg.capsules) {
          // This message contains pasted resources.

          // Make sure they are sorted by position.
          let srcCaps = [...msg.capsules];
          srcCaps.sort((a, b) => a.position - b.position);

          // Rewrite the content to replace each pasted resource with `[<title>](env.<name>)`,
          // where <name> is the binding name stamped onto the message at the turn-start naming
          // chokepoint (see prepareChatBindings).
          let parts: string[] = [];
          let pos = 0;
          for (let capsule of srcCaps) {
            let name = capsule.bindingName;
            parts.push(content.slice(pos, capsule.position));
            // A missing name should be impossible (the chokepoint stamps before replay), but
            // never let it break the whole turn: degrade to a plain title.
            parts.push(name !== undefined
                ? `[${capsule.description.title}](env.${name})`
                : `[${capsule.description.title}]`);
            pos = capsule.position + capsule.length;
          }
          parts.push(content.slice(pos));
          content = parts.join("");
        }

        // The step's persisted model-facing snapshot, if it has one (agent steps persisted since
        // snapshots existed). Fetched before the empty-message check below: a step whose only
        // model-visible content is reasoning (e.g. OpenAI encrypted reasoning with no text) has an
        // empty display record but must still be replayed. A degenerate empty snapshot is treated
        // as absent so the check can still drop the message.
        let storedModelData = msg.author.type === "agent"
            ? hooks.getChatModelData(chatId, msg.sequence) : undefined;
        if (storedModelData && storedModelData.content.length === 0) {
          storedModelData = undefined;
        }

        if (msg.message === "" && !msg.reasoning && !msg.toolCalls && !msg.attachments?.length &&
            !storedModelData) {
          // Anthropic's API will throw an error if you try to send it an empty message.
          // Annoyingly, though, Claude will sometimes produce empty messages. Anyway, let's just
          // drop the message from the log...
          continue;
        }

        let modelMessage: Message;
        // Set when the assistant message was replayed from its snapshot, whose content already
        // includes the step's tool-call blocks; the append after the tool-result replay below
        // must then be skipped.
        let assistantContentComplete = false;
        switch (msg.author.type) {
          case "user":
          case "gadget":
            if (msg.attachments?.length) {
              let parts: (TextContent | ImageContent)[] = [];
              if (content) parts.push({type: "text", text: content});
              let attachmentParts = await Promise.all(msg.attachments.map(
                  async (attachment): Promise<(TextContent | ImageContent)[]> => {
                let filename = attachment.name ? ` (${attachment.name})` : "";
                let workspaceLocation = attachment.workspacePath && session.agentContext.scratch
                    ? `; workspace file env.${session.agentContext.scratch.bindingName}/` +
                      attachment.workspacePath
                    : "";
                let data: Uint8Array;
                try {
                  data = await hooks.getChatAttachmentData(chatId, attachment.id);
                } catch (error) {
                  // A missing legacy payload must not make the entire conversation unusable.
                  // Keep the reference visible, retry on later replay, and never invent bytes.
                  logger.warn("chat attachment unavailable during replay", {
                    event: "chat.attachment.replay.unavailable", chatId, sequence: msg.sequence, error,
                  });
                  return [{type: "text", text: `\n\n[Attached file${filename}${workspaceLocation}; ` +
                    "original contents are currently unavailable.]"}];
                }
                let text = decodeChatAttachmentText(attachment.mimeType, data);
                if (canInlineChatAttachmentImage(attachment.mimeType, data, attachmentImageMaxEdge)) {
                  return [{type: "text", text: `\n\n[Attached image${filename}${workspaceLocation}]`}, {
                    type: "image",
                    data: data.toBase64(),
                    mimeType: attachment.mimeType,
                  }];
                } else if (text !== undefined) {
                  return [{
                    type: "text",
                    text: `\n\n[Attached text file${filename}${workspaceLocation}]\n` +
                        text,
                  }];
                } else if (attachment.mimeType === PDF_MIME_TYPE &&
                           modelApiSupportsPdfAttachments(handle.model.api)) {
                  // pi has no file/document content part, so a PDF rides an ImageContent part;
                  // the model handle rewrites it into the provider's native document block just
                  // before the request goes out (see chat-attachment-pdf.ts). The text part
                  // carries the filename, which the disguised part cannot.
                  return [
                    {type: "text", text: `\n\n[Attached PDF file${filename}${workspaceLocation}]`},
                    {type: "image", data: data.toBase64(), mimeType: attachment.mimeType},
                  ];
                } else {
                  // Model input support does not restrict workspace files. Never decode binary
                  // uploads lossily or send unsupported formats to a provider as image parts.
                  return [{
                    type: "text",
                    text: `\n\n[Attached file${filename} (${attachment.mimeType})${workspaceLocation}; ` +
                        `binary contents are not inlined. Use byte-aware tools to inspect the workspace file.]`,
                  }];
                }
              }));
              parts.push(...attachmentParts.flat());
              modelMessage = { role: "user", content: parts, timestamp: msgTimestamp };
            } else {
              modelMessage = {
                role: "user",
                content,
                timestamp: msgTimestamp,
              };
            }
            break;

          case "agent": {
            // Prefer the persisted snapshot: replayed verbatim (thinking blocks with their
            // signatures, text/thought signatures, true model provenance), it lets pi reflect
            // same-model reasoning back to the provider and apply its cross-model conversions
            // when the chat has switched models. Reconstruction is the fallback for messages
            // persisted before snapshots existed (which never carried reasoning), stamped with
            // the current model so pi treats them as same-model -- their historical behavior.
            let rehydrated = storedModelData &&
                rehydrateStoredAssistantMessage(storedModelData, msg.toolCalls, chatId,
                    msg.sequence);
            if (rehydrated) {
              modelMessage = rehydrated;
              assistantContentComplete = true;
            } else {
              modelMessage = makeReplayAssistantMessage(
                  content !== "" ? [{type: "text", text: content}] : [],
                  handle.model, msgTimestamp);
            }
            break;
          }

          default:
            msg.author.type satisfies never;
            continue;
        }

        session.modelMessages.push(modelMessage);

        if (msg.toolCalls) {
          let modelToolCalls: ToolCall[] = [];

          for (let toolCall of msg.toolCalls) {
            // Recreate the tool output: the exact text the model sees, plus the error flag.
            // Replay cannot re-run the tool, which would need the agent state as it stood
            // when the call was made; instead each branch recomputes the exact output text
            // from the persisted record (AiToolCall), mirroring the corresponding live tool's
            // output format in agent-tools.ts.
            let toolOutput: {text: string, isError?: boolean};
            try {
              if (toolCall.error) {
                toolOutput = {text: `${toolCall.error}`, isError: true};
              } else switch (toolCall.toolName) {
                // Note that if we get here, we know the tool succeeded originally, so for many
                // branches below we can just return success unconditionally.
                case "readFile": {
                  if (session.sawRevertedContent(msgIndex)) {
                    // It would be a total waste of tokens to actually include this file
                    // content in the chat history since it contains changes that were later
                    // reverted -- not to mention a waste of resources to compute the content
                    // of the file. The agent can always read the current file contents if it
                    // needs to.
                    toolOutput = {
                      text: "This call succeeded when the agent first invoked it, but " +
                          "the results have been elided from the chat history because " +
                          "the user later reverted the file to an earlier version.",
                      isError: true,
                    };
                  } else if (toolCall.observedCodeVersion !== undefined) {
                    // A pre-conversion read (from before git-backed code storage): its content
                    // was computed against the retired legacy representation and cannot be
                    // recomputed, so it is elided unconditionally and the agent re-reads.
                    toolOutput = {
                      text: "This call succeeded when the agent first invoked it, but " +
                          "the results have been elided from the chat history because " +
                          "the file has since changed. Re-read the file to see its " +
                          "current content.",
                      isError: true,
                    };
                  } else if (toolCall.observedOid !== undefined ||
                             toolCall.observedCommit !== undefined) {
                    // The read was served from committed code (the workpiece was unpinned; see
                    // the live tool): reproduce exactly the text the model saw, from the blob
                    // the read stamped -- whatever the commit holds now. Deliberately no
                    // staleness check: the model's context must not change from one turn to
                    // the next on account of other chats' accepts (that breaks prompt caching
                    // and reasoning continuity), and the stamp already lets editFile refuse an
                    // edit anchored to content that has since changed. (Reads stamped with a
                    // commit predate oid stamps; the blob is looked up by path there.)
                    let {workpieceId} = hooks.resolveWorkpieceRoot(
                        session.resolveToolWorkpieceId(toolCall.input.workpiece));
                    let oid = toolCall.observedOid ??
                        await hooks.fileOidAtCommit(toolCall.observedCommit!,
                                                    toolCall.input.filename);
                    if (oid === undefined) {
                      throw new Error("File missing from its observed commit.");
                    }
                    toolOutput = {text: readFileWindow(
                        await hooks.readBlobText(oid, toolCall.input.filename), toolCall.input)};
                    session.markFileRead(workpieceId, toolCall.input.filename, oid);
                  } else {
                    let {workpieceId} =
                        hooks.resolveWorkpieceRoot(session.resolveToolWorkpieceId(toolCall.input.workpiece));

                    // The read was served from the session content. Pending edits from earlier
                    // in the same step are applied to the file's text here: the content map
                    // advances only when the step's "changes" message's change applies, so
                    // reads between an edit and that message replay the edits against the
                    // string. Worktree paths absent from the (lazy) session content resolve
                    // against the pinned base, exactly as the live tool resolves them -- so a
                    // worktree the live turn had pinned earlier in this step (by a write, or a
                    // commit() inside executeCode, whose replay re-runs nothing) is pinned
                    // here first, from the step's upcoming declaration.
                    if (hooks.isWorktree(workpieceId)) {
                      await session.ensureReplayContentForWrite(workpieceId, msg.sequence);
                    }
                    const edits = session.pendingReplayEdits.filter(edit => edit.workpieceId === workpieceId &&
                      edit.filename === toolCall.input.filename);
                    const lastWrite = edits.findLastIndex(edit => edit.toolName === "writeFile");
                    // A whole-file write supersedes even an unreadable binary base. Do not
                    // read that obsolete base before replaying the successful replacement.
                    let value: string | null = lastWrite >= 0 ? null
                      : await session.readSessionText(workpieceId, toolCall.input.filename) ??
                        await session.faultWorktreeBase(workpieceId, toolCall.input.filename) ?? null;
                    for (let edit of edits.slice(Math.max(0, lastWrite))) {
                      value = applyPendingEditToText(value, edit);
                    }
                    if (value === null) {
                      throw new Error("File does not exist.");
                    }

                    toolOutput = {text: readFileWindow(value, toolCall.input)};
                    session.markFileRead(workpieceId, toolCall.input.filename);
                  }
                  break;
                }
                case "writeFile": {
                  let {workpieceId} =
                      hooks.resolveWorkpieceRoot(session.resolveToolWorkpieceId(toolCall.input.workpiece));
                  await session.ensureReplayContentForWrite(workpieceId, msg.sequence);
                  session.pendingReplayEdits.push({
                    toolName: "writeFile",
                    workpieceId,
                    filename: toolCall.input.filename,
                    content: toolCall.input.content,
                  });
                  toolOutput = {text: jsonToolResultText({success: true, changeId: session.nextChangeId})};
                  session.markFileRead(workpieceId, toolCall.input.filename);
                  break;
                }
                case "editFile": {
                  let {workpieceId} =
                      hooks.resolveWorkpieceRoot(session.resolveToolWorkpieceId(toolCall.input.workpiece));
                  await session.ensureReplayContentForWrite(workpieceId, msg.sequence);
                  session.pendingReplayEdits.push({
                    toolName: "editFile",
                    workpieceId,
                    filename: toolCall.input.filename,
                    textToReplace: toolCall.input.textToReplace,
                    replacement: toolCall.input.replacement,
                  });
                  toolOutput = {text: jsonToolResultText({success: true, changeId: session.nextChangeId})};
                  // Like writeFile: a successful edit leaves the agent knowing the file's exact
                  // resulting content (the gate guaranteed the before-content, and the edit is
                  // its own), so it counts as session knowledge for further edits.
                  session.markFileRead(workpieceId, toolCall.input.filename);
                  break;
                }
                case "describeBinding":
                  // Recorded rather than re-run, like grep: describing a gatekeeper means calling
                  // it, and the binding (or its API) may have changed since. Logs from before
                  // descriptions were recorded have nothing to return, so the agent re-describes.
                  toolOutput = toolCall.output !== undefined
                      ? {text: toolCall.output}
                      : {
                          text: "This call succeeded when the agent first invoked it, but the " +
                              "description it returned is no longer available. Call " +
                              "describeBinding again if you need it.",
                          isError: true,
                        };
                  break;
                case "setBindingHook":
                case "saveCapsuleAsBinding":
                  // Obsolete tools, which may appear in old chat logs. Their effects were
                  // immediate and permanent (nothing provisional to recover), so replay is a
                  // recorded no-op.
                  toolOutput = {text: jsonToolResultText({success: true})};
                  break;
                case "setGadgetBinding":
                  // The recorded edge (registry state) already exists, stamped by the step's
                  // "changes" message, so replay just reproduces the recorded result.
                  if (toolCall.output === undefined) {
                    throw new Error("setGadgetBinding tool call in log is missing its result");
                  }
                  toolOutput = {
                    text: jsonToolResultText({success: true, changeId: toolCall.output.changeId}),
                  };
                  break;
                case "createGadget": {
                  // A creation tool can't be re-run: the created workpiece ID was persisted as
                  // the tool's recorded result, so replay returns it without creating anything.
                  // (The recorded changeId needs no counter bookkeeping here: it names the
                  // "changes" message that recorded the creation, which is numbered by the
                  // normal "changes" replay below. Likewise a blueprint instantiation needs no
                  // re-fetch: its files ride that same "changes" message, recorded by the
                  // call's own step barrier.)
                  if (toolCall.output === undefined) {
                    throw new Error("createGadget tool call in log is missing its result");
                  }
                  toolOutput = {text: jsonToolResultText(toolCall.output)};
                  break;
                }
                case "createWorktree": {
                  // Like createGadget: a creation tool can't re-run, so replay returns the
                  // recorded result. The worktree starts unpinned; a pin the step went on to
                  // establish (or, in logs from before worktrees pinned on modification, the
                  // birth pin) is declared on the step's "changes" message, and the reads and
                  // writes between here and there establish it early from that declaration.
                  if (toolCall.output === undefined) {
                    throw new Error("createWorktree tool call in log is missing its result");
                  }
                  toolOutput = {text: jsonToolResultText(toolCall.output)};
                  break;
                }
                case "executeCode":
                  toolOutput = {text: toolCall.output!};
                  break;
                case "giveUp":
                  // Obsolete tool: no longer offered, replayed for old chat logs only.
                  toolOutput = {text: jsonToolResultText({rejected: true})};
                  break;
                case "grep":
                  // Recorded rather than re-run: a re-run could pull blobs or match differently.
                  // A search over content the user later reverted would replay as
                  // current-looking source; elide it the way a reverted readFile is.
                  if (session.sawRevertedContent(msgIndex)) {
                    toolOutput = {
                      text: "This call succeeded when the agent first invoked it, but " +
                          "the results have been elided from the chat history because " +
                          "the user later reverted the files to an earlier version.",
                      isError: true,
                    };
                  } else {
                    if (toolCall.output === undefined) {
                      throw new Error("grep tool call in log is missing output");
                    }
                    toolOutput = {text: toolCall.output};
                  }
                  break;
                case "webFetch":
                  if (toolCall.output === undefined) {
                    throw new Error("webFetch tool call in log is missing output");
                  }
                  toolOutput = {text: toolCall.output};
                  break;
                case "observeUserChanges":
                  // The agent shouldn't call this tool explicitly (synthetic calls are
                  // reconstructed from "changes"/"revert" messages, not stored in the log), but
                  // if it did, replay the same brush-off the live tool returns.
                  toolOutput = {text: OBSERVE_USER_CHANGES_NOOP_RESULT};
                  break;
                case "listBlueprints":
                case "listConnectableResources":
                case "requestConnection":
                  toolOutput = {text: toolCall.output ?? ""};
                  break;
                case "activateSkill":
                case "delegateToBot":
                case "messageBot":
                  toolOutput = {text: toolCall.output ?? ""};
                  break;
                case "createExternalResource":
                  // Like createGadget: replay re-binds the recorded gatekeeper, never re-creates.
                  if (toolCall.output === undefined) {
                    throw new Error(
                        "createExternalResource tool call in log is missing its result");
                  }
                  toolOutput = {text: jsonToolResultText(toolCall.output)};
                  break;
                default:
                  toolCall satisfies never;
                  throw new Error("Unknown tool.");
              }
            } catch (err) {
              toolOutput = {text: `${err}`, isError: true};

              // This indicates a bug in the replay logic, so report it to logs.
              logger.error("error in tool call replay", {
                event: "agent.tool.call.replay.failed",
                toolName: toolCall.toolName, toolCallId: toolCall.toolCallId, error: err,
              });
            }

            session.modelMessages.push({
              role: "toolResult",
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName,
              content: [{type: "text", text: toolOutput.text}],
              isError: toolOutput.isError ?? false,
              timestamp: msgTimestamp,
            });

            modelToolCalls.push({
              type: "toolCall",
              id: toolCall.toolCallId,
              name: toolCall.toolName,
              arguments: toolCall.input,
            });
          }

          if (modelMessage.role === "assistant" && !assistantContentComplete) {
            modelMessage.content = [...modelMessage.content, ...modelToolCalls];
          }
        }

        break;
      }

      case "changes": {
        // The message's binding effects (user-created gadgets and worktrees entering the chat's
        // binding map) were folded in by applyMessageBindings above, before this case ran --
        // the diff rendering below name-addresses workpieces through that scope.


        // A migrated chat's conversion boundary acts as an epoch boundary that re-seeds at
        // (pin bases + this change): everything before it is text-only history whose code payloads
        // are unrecoverable (pre-conversion reads were elided above). The reset applies *even
        // when the boundary itself was reverted* (reverting at the boundary erases the
        // converted content, not the boundary): pre-conversion writes leave session.pendingReplayEdits
        // that no pre-conversion message discharges (none carries a change or watermark), and they
        // must not leak into the post-boundary epoch. The pre-boundary log contributes no changes
        // or pins, so the rest of the reset is a no-op either way (pre-conversion writes marked
        // files read, but with no session content to stamp them from they drop, as they must:
        // the converted content is not what those writes produced).
        if (msg.conversionBoundary) await session.resetSessionEpoch();

        // A blueprint that the user applied is described to the model (see
        // formatBlueprintProposal). Its message has no change, only the pin at the merge
        // commit, which is applied below. A proposal since reverted is described all the same:
        // the description is what the turn that reviewed it was answering, and the revert is
        // reported where it happened. (An entry on a message of the agent's own is a gadget it
        // created from a blueprint, which the model already sees in its createGadget call.)
        for (let merge of msg.author.type === "user" ? msg.blueprintMerges ?? [] : []) {
          session.modelMessages.push({
            role: "user",
            content: await formatBlueprintProposal(merge, msg, session.chatNameFor(merge.gadgetId), hooks),
            timestamp: msgTimestamp,
          });
        }

        if (session.chatMessageStatus.get(msg.sequence) !== "reverted") {
          // Pins this batch establishes enter the content before the change applies (a no-op for
          // gadgets session.ensureReplayContentForWrite already established early; see there).
          let forgotten = new Map<WorkpieceId, string[]>();
          for (let pin of msg.pins ?? []) {
            forgotten.set(pin.gadgetId, await session.applyReplayedPin(pin));
          }
          // A batch with no `change` records only creations/binding additions; there is nothing to
          // apply to the session content (and no diff), but user-authored creations/additions
          // are still surfaced as observations below. A conversion boundary's change is not user
          // activity -- it re-records content from before the boundary, which the model already
          // saw (or wrote) -- so it applies without an observation.
          let isUserActivity = msg.author.type === "user" && !msg.conversionBoundary;
          let diff: string | undefined;
          if (msg.change !== undefined) {
            await session.seedWorktreeBasesForChange(msg.change);
            diff = session.applyReplayedChange(msg.change, isUserActivity);
          }
          if (isUserActivity) {
            // Surface everything the user did in this batch as one synthetic observation:
            // gadgets they created and bindings they added from the workspace UI
            // (agent-initiated creations/additions need no note -- the model already sees its
            // own tool calls and recorded results), followed by the diff of their file edits. A
            // creation-only batch has a no-op update and thus no diff.
            let observations = (msg.createdGadgets ?? []).map(({title, bindingName}) =>
                `Created new gadget ${JSON.stringify(title)}, available in your env as ` +
                `\`env.${bindingName}\`.`);
            for (let {gadgetId, name} of msg.addedBindings ?? []) {
              let gadgetName = session.chatNameFor(gadgetId);
              observations.push(
                  `Added binding "${name}" to ` +
                  (gadgetName !== undefined ? `gadget ${gadgetName}` : `a gadget`) + `.`);
            }
            if (msg.mainlineMerge?.gadgets !== undefined) {
              // An update from mainline is a re-root with no change, described by its commits
              // (see formatMainlineMerge). One recorded before merges were commits has a change
              // instead, which is shown as a diff like any other.
              let summaries: string[] = [];
              for (let entry of msg.mainlineMerge.gadgets) {
                let name = session.chatNameFor(entry.gadgetId);
                let declaration = msg.pins?.find(pin => pin.gadgetId === entry.gadgetId);
                if (name === undefined || declaration === undefined) continue;
                summaries.push(await formatMainlineMerge(entry, declaration, name,
                    forgotten.get(entry.gadgetId) ?? [], hooks));
              }
              if (summaries.length > 0) {
                observations.push(MAINLINE_MERGE_INTRO, ...summaries);
              }
            }
            if (diff !== undefined) {
              observations.push(diff);
            } else if (msg.update !== undefined) {
              // A pre-conversion batch (see AiChatMessageBody.conversionBoundary): its retired
              // Yjs payload -- still on the stored record -- can't be applied or diffed, so the
              // user's edits get a generic note instead of a diff. The conversion boundary
              // later in the log re-establishes the content itself.
              observations.push(
                  "The user edited the gadget code. (The specific changes are no longer " +
                  "available; read the files to see their current content.)");
            }
            if (observations.length > 0) {
              session.modelMessages.push(...makeReplayObservation(
                  msg.sequence, observations.join("\n\n"), handle.model, msgTimestamp));
            }
          }
        }
        // A batch that materialized rows discharges the pending edits it covers (its change
        // re-records their content); a batch carrying neither flushed no edits, so it doesn't
        // discharge any.
        if (msg.change !== undefined || msg.watermark !== undefined) {
          session.pendingReplayEdits = [];
        }
        session.changeIdMap.set(msg.sequence, session.nextChangeId);
        ++session.nextChangeId;
        break;
      }

      case "merge":
        // Nothing to tell the agent, but a boundary merge closed the chat's epoch: the session
        // content restarts empty, later pins re-seed lazily, and the model's file knowledge
        // becomes knowledge of committed code (see session.resetSessionEpoch).
        if (msg.epochBoundary) {
          await session.resetSessionEpoch();
          // Merges from before worktrees pinned on modification re-pinned every worktree at
          // the boundary and recorded it here (see AiChatMessageBody.worktreePins); those
          // pins re-establish immediately so the epochs they root fold as written.
          for (let pin of msg.worktreePins ?? []) {
            if (hooks.isWorktree(pin.worktreeId)) {
              await session.applyReplayedPin({gadgetId: pin.worktreeId, baseCommit: pin.baseCommit});
            }
          }
        }
        break;

      case "slashCommand":
        // This records what the user invoked for display; only a generated message is model input.
        break;

      case "revert": {
        // Name the first change the revert discarded: the earliest batch still proposed when it
        // was recorded. A revert reaching into the summarized turns can't be named that way, since
        // the batches it may have discarded there aren't replayed.
        let revertsSummarizedTurns = msg.revertFrom < (checkpoint?.compactedTo ?? 0);
        let firstReverted = revertsSummarizedTurns ? undefined
            : foldProposedChanges(chatMessages.slice(0, msgIndex))
                .find(batch => batch.sequence >= msg.revertFrom);
        let revertedFromChangeId = firstReverted && session.changeIdMap.get(firstReverted.sequence);
        session.modelMessages.push(...makeReplayObservation(
            msg.sequence,
            revertsSummarizedTurns
                ? "The user reverted all pending changes from a point in the summarized " +
                  "earlier turns onward."
                : revertedFromChangeId === undefined ? "The user discarded pending changes."
                : `The user reverted all changes starting from change ${revertedFromChangeId} ` +
                  `onward. The files have returned to the state they were in immediately ` +
                  `before change ${revertedFromChangeId}.`,
            handle.model, msgTimestamp));
        break;
      }

      case "agentCallback": {
        // The args binding name was stamped on the message when the call was appended to the log
        // (drainPendingAgentCalls in overseer.ts), unique in the chat's scope at that point. A
        // message without one predates durable calls: its arguments were transient and are gone.
        let name = msg.bindingName;
        let content: string;
        if (name === undefined) {
          content =
              `A callback was received: \`self.${msg.methodName}()\`. ` +
              `Its arguments are no longer available.`;
        } else {
          let call = session.agentContext.spawnerTypes
              ? `The Gadget called \`${msg.methodName}()\` on your interface.`
              : `A callback was received: \`self.${msg.methodName}()\`.`;
          content =
              `${call} Arguments (\`env.${name}\`):\n${msg.argsSummary}\n\n` +
              `Access the full arguments as \`env.${name}\` (an array, one element per ` +
              `parameter) in executeCode.`;
        }

        session.modelMessages.push({ role: "user", content, timestamp: msgTimestamp });
        break;
      }

      case "agentNudge":
        // A decision resume's durable handoff, without impersonating a new user prompt.
        session.modelMessages.push({ role: "user", content: msg.text, timestamp: msgTimestamp });
        break;

      case "connectionRequest": {
        // Surface the outcome of a connection request to the agent. While pending, the name the
        // agent chose is claimed in the chat's scope but there is nothing actionable to report
        // (the agent already saw the tool's "awaiting" output and ended its turn). On accept the
        // agent is resumed and reads this as a user message describing the result; on deny it
        // isn't resumed (and the name is released), but the note is still surfaced here so the
        // agent sees the outcome the next time the user messages it.
        if (msg.state === "pending") {
          // The pending claim was folded in by applyMessageBindings above; nothing actionable
          // to report (the agent already saw the tool's "awaiting" output and ended its turn).
        } else if (msg.state === "accepted") {
          if (msg.gatekeeperId !== undefined && msg.bindingName !== undefined) {
            // The accepted resource enters the chat's env under the name recorded on the request
            // (chosen by the agent, or stamped lazily for requests made before agents named
            // their own); the binding itself was folded in by applyMessageBindings above.
            let name = msg.bindingName;
            session.modelMessages.push({
              role: "user",
              content:
                  `The user accepted your connection request for "${msg.vendorName}". ` +
                  `The resource is available as \`env.${name}\` for use in executeCode ` +
                  `in this conversation. Use describeBinding("${name}") to learn its API, then ` +
                  `use it. If a Gadget's code needs it permanently, use setGadgetBinding to wire ` +
                  `it into that gadget.`,
              timestamp: msgTimestamp,
            });
          } else {
            // Defensive: accept always records a gatekeeperId, so this shouldn't happen — but never
            // leave a resumed agent with no context about the outcome.
            session.modelMessages.push({
              role: "user",
              content:
                  `The user accepted your connection request for "${msg.vendorName}", but the ` +
                  `connected resource isn't available to you right now. Ask the user to try again ` +
                  `or proceed without it.`,
              timestamp: msgTimestamp,
            });
          }
        } else if (msg.state === "denied") {
          session.modelMessages.push({
            role: "user",
            content:
                `The user denied your connection request for "${msg.vendorName}". ` +
                `Do not retry the same request; wait for the user to tell you how to proceed.`,
            timestamp: msgTimestamp,
          });
        }
        break;
      }

      case "catalogChange":
        session.replayCatalogChange(msg.sequence, msg.resources, msgTimestamp);
        break;

      case "action":
      case "useGadget":
      case "error":
        // No need to tell the agent about this.
        break;

      default:
        msg satisfies never;
        break;
    }

    while (session.modelMessageSources.length < session.modelMessages.length) {
      session.modelMessageSources.push({
        sequence: msg.sequence,
        canCut: session.modelMessageSources.length === modelMessageStart,
      });
    }
  }
}
