import { AGENT_SPAWNER_CONNECTION_ID, AiChatMessage, AiChatAuthorInfo, AiToolCall, BlueprintBinding, BlueprintMerge, ChatGadgetPinRecord, MainlineMergeGadget, WorkpieceId, type AiModelConfig } from '@gadgets/workshop-shared/api';
import { PDF_MIME_TYPE, modelApiSupportsPdfAttachments } from './chat-attachment-pdf';
import { canInlineChatAttachmentImage, decodeChatAttachmentText, isAllowedChatAttachmentImageMimeType } from './chat-attachment-validation';
import { createWorkshopLogger } from "./observability";
import {
  Type,
  getSystemMessageText,
  isRetryableAssistantError,
  toToolDeclaration,
} from "@earendil-works/pi-ai";
import type{
  AssistantMessage,
  ImageContent,
  Message,
  SystemMessage,
  TextContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import {
  runAgentLoopContinue,
  type AgentContext,
  type AgentEvent,
} from "@earendil-works/pi-agent-core";
import { RpcStub as NativeRpcStub } from "cloudflare:workers";
import { seenAlwaysAvailableResources } from "./agent-catalog";
import { formatInstanceInstructions } from "./admin-config";
import { traceRejectedToolCall, traceTool } from "./agent-tracing";
import { AgentTurnError, completeText, httpStatusFromError } from "./ai-invoke";
import { buildTools, readFileWindow, jsonToolResultText, defineTool } from "./agent-tools";

import type{ AgentProgress } from "./agent-session";
import {
  COMMUNICATION_GUIDANCE,
  SYSTEM_PROMPT,
  SPAWNER_SYSTEM_PROMPT,
  SPAWNED_AGENT_TOOLS,
  SPAWNED_TASK_PROMPT,
  formatCallableAgentPrompt,
  OBSERVE_USER_CHANGES_NOOP_RESULT,
  formatMissingBlueprintBindings,
} from "./agent-prompt";
import {
  createTurnSession,
  applyPendingEditToText,
  makeReplayObservation,
  makeReplayAssistantMessage,
  makeStoredAssistantMessage,
} from "./agent-session";
import type{ ChatHistory, AiChatMessageBodyWithModelData } from "./agent-hooks";
import type{ AgentHooks } from "./agent-hooks";
import { applyMessageBindings } from "./project-chat-log";
import { findCatalogChanges } from "./agent-catalog";
import type{ CachedRequest, ModelHandle } from "./ai-models";
import type{
  ChatBindingEntry,
  CompactionCheckpoint,
  StoredAssistantMessage,
} from "./storage-schema/overseer-storage";
import {
  buildCompactionState,
  buildSummaryPrompt,
  COMPACTION_SYSTEM_PROMPT,
  estimateProjectionTokens,
  findCompactionBoundary,
  findProtectedFromSequence,
  foldProposedChanges,
  getModelTokenLimits,
  isCompactionTurn,
  shouldCompactChat,
  type CompactionProjectionMessage,
} from "./agent-compaction";
import {
  requestAnthropicCompaction,
  supportsAnthropicCompaction,
  withAnthropicCompactionBlock,
} from "./anthropic-compaction";


const logger = createWorkshopLogger("workshop.agent");








// Why one pass of the agent returned to runAgent's loop: the turn ran to a stop, leaving its last
// model request if the chat's next request will start with it; a persisted tool step left the
// next request over the compaction trigger, so the pass ended for a reload; or the pass
// summarized instead of prompting the model and this is the checkpoint to publish.
type AgentPassOutcome =
  | {type: "finished"; lastRequest?: CachedRequest}
  | {type: "reloadForCompaction"}
  | {type: "compacted"; checkpoint: CompactionCheckpoint}
  | {type: "transientFailure"; error: AgentTurnError};



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




// Locates `textToReplace` in `content`, enforcing editFile's exactly-one-match contract. The
// returned position is also where the live tool anchors its exact-span change.


/** The line window a readFile call asked for (see AiToolCall's readFile input). */


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




/** How many times one agent turn retries a model request that failed transiently. */
const TRANSIENT_FAILURE_RETRIES = 2;

/**
 * Runs one agent turn against the chat's history, compacting as needed. A pass over the history
 * may compact instead of prompting the model, or end after a persisted tool step because the next
 * request would cross the compaction trigger; either way the loop reloads the durable history,
 * which the next pass compacts first, and goes again. Each compaction moves the boundary strictly
 * forward and can never pass the newest turn start, so the loop is bounded. `/compact` is done once
 * it has compacted; the model is never prompted. A pass whose model request failed transiently is
 * also run again, a bounded number of times. Resolves with the turn's last model request if the
 * chat's next request will start with it, so keeping that request cached pays off.
 */
export async function runAgent(
    hooks: AgentHooks,
    handle: ModelHandle,
    chatId: number,
    author: AiChatAuthorInfo,
    abortSignal: AbortSignal,
    initiator: AiChatAuthorInfo,
    modelConfig: AiModelConfig): Promise<CachedRequest | undefined> {
  // Provider retries and compaction reloads are passes of this execution, not new executions.
  const progress: AgentProgress = {
    executionId: crypto.randomUUID(),
    barrierSequence: 0,
  };
  let retries = 0;
  while (true) {
    let history = hooks.loadChatHistory(chatId);
    let outcome = await runAgentPass(
        hooks, handle, chatId, author, history, abortSignal, initiator, modelConfig, progress);
    if (outcome.type === "transientFailure") {
      if (++retries > TRANSIENT_FAILURE_RETRIES) throw outcome.error;
      // The failed request persisted nothing, so the retry starts from the last saved step. What
      // it streamed was only provisional; clients drop it so the retry doesn't append to it.
      hooks.emitChatStreamEvent(chatId, {type: "streamReset"});
      await scheduler.wait(1000 * retries);
    }
    if (outcome.type === "compacted") hooks.commitChatCompaction(chatId, outcome.checkpoint);
    if (outcome.type === "finished") return outcome.lastRequest;
    if (isCompactionTurn(history.chatMessages)) return undefined;
    abortSignal.throwIfAborted();
  }
}

async function runAgentPass(
    hooks: AgentHooks,
    handle: ModelHandle,
    chatId: number,
    author: AiChatAuthorInfo,
    {checkpoint, chatMessages, measuredTokens}: ChatHistory,
    abortSignal: AbortSignal,
    initiator: AiChatAuthorInfo,
    modelConfig: AiModelConfig,
    progress: AgentProgress): Promise<AgentPassOutcome> {
  const progressLogger = logger.with({chatId, executionId: progress.executionId});

  // The workspace's gadget registry, snapshotted at the start of the turn (gadgets provisional
  // to other chats are excluded -- they belong to those chats' proposed changes). This is the
  // enumeration source of truth for which Y.Doc roots hold gadget files (roots of gadgets
  // deleted from the registry are inert). A gadget created mid-turn (via createGadget) isn't
  // in this snapshot, but nothing here needs it: the system prompt was already built, and
  // replayed "changes" messages predate it.
  const session = await createTurnSession({hooks, handle, chatId, checkpoint, chatMessages, progress, progressLogger});
  // Rebuild the code the compacted prefix left behind: first the checkpoint's pins establish
  // their base trees, then the composed proposed change applies on top. (A pre-conversion
  // checkpoint carries neither -- its retired Yjs fields are ignored; the conversion boundary
  // in the tail re-establishes the content.)
  for (let pin of checkpoint?.pins ?? []) {
    await session.applyReplayedPin(pin);
  }
  if (checkpoint?.proposedChange) {
    await session.seedWorktreeBasesForChange(checkpoint.proposedChange);
    session.applyReplayedChange(checkpoint.proposedChange, false);
  }

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
            // TODO: Refactor so that we're not duplicating tool implementations...
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

  // Deployment-wide admin instructions, appended to the static system slot (slot 0) so they stay
  // inside the Anthropic prompt cache window. "" when unset.
  let instanceInstructions = formatInstanceInstructions(await hooks.getInstanceInstructions());

  // The two system prompt slots: the non-project-specific parts, followed by the
  // project-specific parts. They become the leading system message's content and its one
  // section, which pi renders as `${slot0}\n\n${slot1}`. On APIs with cache breakpoints, the
  // model handle sends that as two blocks with a breakpoint between them (see
  // system-prompt-blocks.ts), so the static prefix stays cached when the project-specific part
  // changes.
  let systemPromptSlots: [string, string];
  // The regular agent's list of the workspace's gadgets, built for this pass when no persisted
  // listing exists (see the regular-agent branch below); a spawnerConfig chat never builds one.
  let systemPromptWorkspace: string | undefined;
  // Builds the workspace gadget listing: each gadget's files as of the start of the thread (or
  // of its latest compaction), so mid-thread changes don't thrash the prompt cache. Computed
  // only on demand -- by the first pass without a persisted listing, and by compaction, which
  // refreshes the listing for the history it prunes.
  let computeWorkspaceSection = async (): Promise<string> => {
    if (session.gadgetInfos.length == 0) {
      return "As of the start of this session, this workspace contained no gadgets. You can use " +
          "connected resources and executeCode without one. Use `createGadget` tool only when the " +
          "task calls for a new application or saved output, before writing that gadget's files.";
    }
    let sections: string[] = [];
    for (let info of session.gadgetInfos) {
      // The file list follows the same pinned/unpinned split as readFile: an unpinned gadget
      // with committed code lists its head commit's files (the head fixed for this turn);
      // pinned gadgets and gadgets with no committed code list from the session content.
      let files: string[];
      let unpinnedHead = !session.pinnedGadgets.has(info.id) ? session.observeHead(info.id) : undefined;
      if (unpinnedHead !== undefined) {
        files = [...(await hooks.readCommitFiles(unpinnedHead)).keys()];
      } else {
        files = [...(session.sessionContent.get(info.id)?.keys() ?? [])];
      }
      let envName = session.chatNameFor(info.id);
      let lines = [envName !== undefined
          ? `## Gadget ${envName}: ${JSON.stringify(info.title)}`
          : `## Gadget ${JSON.stringify(info.title)} (no binding in your env)`];
      if (info.isDefault) {
        lines.push(
            `This is the workspace's default gadget: file tools operate on it when their ` +
            `\`workpiece\` parameter is omitted.`);
      }
      if (files.length == 0) {
        lines.push(`As of the start of this session, this gadget had no code files.`);
      } else {
        lines.push(
            `As of the start of this session, this gadget contained the following files:`,
            ...files.map(f => `* ${f}`));
      }
      if (info.output) {
        // When people are using common platform formats/outputs, most times people just want to use
        // them, not to edit them. Especially non-technical folks. We tell the agent to wait to be
        // explicitly asked.
        lines.push(
            `This gadget is a ${info.output.noun}: a finished application whose content is data ` +
            `in its own storage, not text in its code. To read or change what it contains, call ` +
            `its RPC methods from \`executeCode\`` +
            (envName !== undefined ? ` (\`env.${envName}\`)` : ``) +
            `; read its README.md or server.js to learn the methods it offers for this. Do NOT ` +
            `edit its code to change its content. Edit the code only if the user asks to change ` +
            `how the ${info.output.noun} itself works (its editor, layout, or features).`);
      }
      if (info.bindings.length == 0) {
        lines.push(`This gadget has no bindings.`);
      } else {
        // For each of the gadget's own bindings, cross-reference how the agent can reach the
        // same resource in its own env (matched by target workpiece), if it can.
        lines.push(`This gadget's bindings (as its own code sees them):`,
                   ...info.bindings.map(b => {
          let chatName = session.chatNameFor(b.target);
          return `* ${b.name}: ${b.title}` +
              (chatName !== undefined
                  ? ` — in your env as \`env.${chatName}\``
                  : envName !== undefined
                  ? ` — (no binding for this in your env; describeBinding with ` +
                    `\`gadget: "${envName}"\` describes it)`
                  : ` — (no binding for this in your env)`);
        }));
      }
      sections.push(lines.join("\n"));
    }
    return `# This workspace's gadgets\n\n${sections.join("\n\n")}`;
  };

  if (session.agentContext.spawnerConfig) {
    // This is a spawned agent. Build an appropriate system prompt. Spawned agents see only the
    // bindings the spawner configured (snapshotted into the chat's seed layer at spawn time),
    // never the whole workspace.
    let namedSeeds = session.seedBindings.filter(seed => seed.catalog === undefined);
    let systemPromptBindings: string;
    if (namedSeeds.length == 0) {
      systemPromptBindings =
          "Aside from `env.GIT` and any resources described below, the `env` object is empty.";
    } else {
      let lines = namedSeeds.map(seed =>
          `* env.${seed.name} — ` +
          (seed.isGadget
              ? `the Gadget ${JSON.stringify(seed.title)}: \`.rpc\` is an RPC stub to its ` +
                `server-side Durable Object, \`.exports\` exports it as a file.`
              : seed.title));
      systemPromptBindings =
          `You have access to the following bindings via the \`env\` object:\n${lines.join("\n")}`;
    }

    // Split the system prompt into static and dynamic parts for better caching. How the task is
    // delivered depends on how the chat was spawned, and for a callable agent includes the
    // chat-specific (but stable across the chat) interface, so that goes in the second slot.
    systemPromptSlots = [
      SPAWNER_SYSTEM_PROMPT,
      [
        session.agentContext.spawnerTypes
            ? formatCallableAgentPrompt(session.agentContext.spawnerTypes)
            : SPAWNED_TASK_PROMPT,
        systemPromptBindings,
        session.alwaysAvailableResourcesPrompt,
      ].filter(part => part !== "").join("\n\n"),
    ];
  } else {
    // This is a regular coding agent.

    // The workspace gadget listing is built only when no persisted one exists -- the first
    // pass of the thread, or a checkpoint that predates the listing. Otherwise the persisted
    // snapshot is reused (the prompt section below prefers it), skipping the per-gadget file
    // reads in computeWorkspaceSection entirely.
    let savedWorkspace = checkpoint ? checkpoint.workspacePrompt : session.agentContext.workspacePrompt;
    if (savedWorkspace === undefined) {
      systemPromptWorkspace = await computeWorkspaceSection();
      if (checkpoint === undefined) {
        hooks.setChatWorkspacePrompt(chatId, systemPromptWorkspace);
      }
    }

    // Named in the prompt because the request that should trigger them ("make me a doc") may
    // not look trigger the agent to browse blueprints.
    let standardFormats = await hooks.describeStandardFormats();

    // Build connectable-vendors section. We only list vendor names here; the agent fetches a
    // vendor's resource URL patterns on demand via listConnectableResources.
    let connectableVendors = await hooks.listConnectableVendors();
    let systemPromptConnections: string;
    if (connectableVendors.length == 0) {
      systemPromptConnections = "";
    } else {
      systemPromptConnections =
          `\n\nIf you need access to an external resource that isn't already a binding, you can ask ` +
          `the user to connect one with the requestConnection tool (pre-configure it as much as you ` +
          `can; use listConnectableResources to learn a vendor's resource URL patterns first). The ` +
          `user accepts or denies in the chat. If they accept, you'll be resumed and the resource ` +
          `becomes available as a binding in your env; if they deny, your turn ends and you wait ` +
          `for the user's next message.\n` +
          `If one of these services likely holds information relevant to the task, consider ` +
          `requesting a connection and reading from it before you answer, instead of answering from ` +
          `guesswork — a connection often gives you the real information. Connectable vendors:\n` +
          `${connectableVendors.map(v => `* ${v.id}: ${v.displayName}`).join("\n")}`;
    }

    // Split the system prompt into static and dynamic parts for better caching.
    systemPromptSlots = [
      SYSTEM_PROMPT,
      (standardFormats ? `${standardFormats}\n\n` : "") +
          `${savedWorkspace ?? systemPromptWorkspace}${systemPromptConnections}` +
          (session.alwaysAvailableResourcesPrompt ? `\n\n${session.alwaysAvailableResourcesPrompt}` : "") +
          // The bot section is part of the chat's identity, so it lives in the dynamic slot
          // (slot 1): slot 0 stays byte-stable, preserving the cross-chat cache prefix, and a
          // mid-chat bot switch costs exactly one cache miss. Only regular chats run as bots --
          // gadget-spawned agents never do -- so the spawner branch above needs nothing.
          (session.agentContext.botSection ? `\n\n${session.agentContext.botSection}` : ""),
    ];
  }

  // Shared guidance precedes deployment instructions for both agent types.
  systemPromptSlots[0] += `\n\n${COMMUNICATION_GUIDANCE}`;
  if (instanceInstructions) {
    systemPromptSlots[0] += `\n\n${instanceInstructions}`;
  }
  // Prompt caches are shared across the provider account, so anyone on it could probe for a cached
  // prefix. The workspace's random salt leads the project-specific part, so nobody without this
  // prompt can probe that part, or the chat after it.
  let systemMessage: SystemMessage = {
    role: "system", content: systemPromptSlots[0],
    sections: {
      environment: `Prompt cache salt (ignore): ${hooks.getPromptCacheSalt()}\n\n` +
          systemPromptSlots[1],
    },
    timestamp: 0,
  };

  // Some models charge their response to the same window as the prompt, so the reservation is both
  // withheld from the prompt's budget and sent as the response cap -- the two can't disagree.
  let {inputBudget, maxOutputTokens} = getModelTokenLimits(modelConfig);

  let projection: CompactionProjectionMessage[] = session.modelMessages.map((message, index) => ({
    message, ...session.modelMessageSources[index],
  }));
  let lastMeasuredSequence = chatMessages.findLast(message =>
    message.type === "message" && message.author.type === "agent")?.sequence;
  // `measuredTokens` covers the prompt and response of the last model step, so estimate only what
  // was added after it. A tool result carries the call's sequence but wasn't in that usage.
  // (The system prompt is not part of the projection, so the pure estimate adds it separately.)
  let contextTokens = measuredTokens > 0 && lastMeasuredSequence !== undefined
    ? measuredTokens + estimateProjectionTokens(
        projection.filter(({message, sequence}) => sequence !== undefined &&
          (sequence > lastMeasuredSequence ||
           (sequence === lastMeasuredSequence && message.role === "toolResult"))))
    : estimateProjectionTokens(projection) +
        Math.ceil(getSystemMessageText(systemMessage).length / 4);

  // Wraps a plain-text tool result (the exact text the model sees) with optional recorded notes
  // (see AiToolCall: observedCodeVersion, recorded output) riding along as pi `details` for the
  // turn_end persister to merge into the chat log. Success data rides details; error-path notes
  // go through session.toolCallNotes instead, because pi drops `details` for thrown errors.



  // The bot list is tool-advertising, not turn-critical: a user-DO or KV hiccup must not fail
  // the pass, so it degrades to an empty list (the tools are simply omitted this turn).
  let delegatableBots = session.agentContext.spawnerConfig ? []
      : await hooks.listDelegatableBots(chatId).catch(() => []);
  let delegatableBotsList = delegatableBots.length === 0 ? ""
      : delegatableBots.map(bot =>
            `- ${bot.name} (${bot.key})${bot.description ? `: ${bot.description}` : ""}`)
          .join("\n");
  // The built-in tools, closures over the turn session (see agent-tools.ts).
  let tools = buildTools({session, hooks, chatId, author, initiator});

  if (session.agentContext.botConfig) {
    tools.activateSkill = defineTool({
      name: "activateSkill",
      label: "Activate skill",
      description:
          "Activate one of this bot's skills on demand (see the Skills section of the system " +
          "prompt). Pass the skill's command id, or its title when unambiguous. Returns the " +
          "skill's agent-visible result text.",
      parameters: Type.Object({
        skill: Type.String({
          description: 'The skill to activate: its command id (e.g. "search") or its title.',
        }),
      }),
      execute: async (toolCallId, input) => {
        try {
          let output = await hooks.invokeBotSkill(chatId, input.skill);
          return session.toolResult(output, {output});
        } catch (error) {
          session.toolCallNotes.set(toolCallId, {error: session.toolErrorText(error)});
          throw error;
        }
      }
    });
  }

  if (delegatableBots.length > 0) {
    tools.delegateToBot = defineTool({
      name: "delegateToBot",
      label: "Delegate to bot",
      description:
          "Run another bot as a subagent of this chat: it starts (or continues) its own " +
          "visible thread, works on the task, and this chat waits for its reply. Pass " +
          "threadId from a earlier call to send the same bot a follow-up on its thread. " +
          "Bots available to the initiator of this chat:\n" + delegatableBotsList,
      parameters: Type.Object({
        bot: Type.String({
          description: 'The bot to run, by key (e.g. "u:3" or "d:slug").',
        }),
        message: Type.String({
          description: "The task for the bot, stated completely: it sees no other context " +
              "from this chat.",
        }),
        threadId: Type.Optional(Type.Number({
          description: "threadId returned by an earlier delegateToBot call, to continue that " +
              "thread instead of starting a new one.",
        })),
      }),
      execute: async (toolCallId, input) => {
        try {
          let result = await hooks.runBotSubagent(
              chatId, input.bot, input.message, input.threadId, toolCallId, abortSignal);
          let output = JSON.stringify(result);
          return session.toolResult(output, {output});
        } catch (error) {
          session.toolCallNotes.set(toolCallId, {error: session.toolErrorText(error)});
          throw error;
        }
      }
    });

    tools.messageBot = defineTool({
      name: "messageBot",
      label: "Message bot",
      description:
          'Send a direct message to another bot (or to "orchestrator", the chat that ' +
          'delegated to this one) without waiting for a reply: an idle bot starts a turn and ' +
          'answers in its own thread; a mid-turn bot receives it as a steer. Use ' +
          'delegateToBot for blocking Q&A; use this to hand off, notify, or coordinate ' +
          'asynchronously. Targets are bot keys (e.g. "u:3", "d:slug"), bot names, or ' +
          '"orchestrator".',
      parameters: Type.Object({
        to: Type.String({
          description: 'The recipient: a bot key, a bot name, or "orchestrator".',
        }),
        text: Type.String({description: "The message body."}),
      }),
      execute: async (toolCallId, input) => {
        try {
          let output = await hooks.deliverBotMessage(chatId, input.to, input.text);
          return session.toolResult(output, {output});
        } catch (error) {
          session.toolCallNotes.set(toolCallId, {error: session.toolErrorText(error)});
          throw error;
        }
      }
    });
  }

  if (session.agentContext.spawnerConfig) {
    // Restrict sub-agents to a narrower set of tools. No user is present to approve changes, so
    // they get nothing that modifies gadgets or requests connections; they can inspect and call
    // bindings, fetch the web, and work on worktrees (writes to gadgets are refused by
    // session.assertMayModifyWorkpiece).
    tools = Object.fromEntries(SPAWNED_AGENT_TOOLS.map(name => [name, tools[name]]));
  }

  // Calls that reached a tool's execute(), so tool_execution_end can tell the ones pi rejected.
  let executedToolCalls = new Set<string>();
  let toolList = Object.values(tools).map(tool => traceTool(tool, executedToolCalls));

  // Records a turn that ended with a provider error, so it can be retried or rethrown for the
  // overseer's error triage after the loop settles. (pi never throws for provider failures; the
  // loop reports them as a final assistant message with stopReason "error"/"aborted".) Nothing
  // from a failed turn is persisted.
  let turnFailure: AssistantMessage | undefined;

  // Set when the next provider request would cross the preferred compaction budget. The
  // turn_end barrier persists this step before the caller reloads durable history.
  let reloadForCompaction = false;

  // Whether the request after the latest step fits under the compaction trigger, so it will start
  // with that step's request.
  let nextRequestFits = false;

  // pi 0.87 calls finishTurn before turn_end. Capture actions there so the stop decision can
  // see them; the awaited turn_end barrier then persists this same snapshot before another
  // model request is allowed to start.
  let capturedActionsForStep: ReturnType<AgentHooks["consumeCapturedActions"]>;

  // The awaited event sink driving both the client stream fan-out and the persistence barrier.
  let emit = async (event: AgentEvent): Promise<void> => {
    switch (event.type) {
      case "message_update": {
        // Live streaming fan-out to connected clients.
        let ev = event.assistantMessageEvent;
        switch (ev.type) {
          case "text_delta":
            session.emitStreamEvent({type: "textDelta", delta: ev.delta});
            break;
          case "thinking_delta":
            session.emitStreamEvent({type: "reasoningDelta", delta: ev.delta});
            break;
          case "toolcall_start": {
            let block = ev.partial.content[ev.contentIndex];
            if (block?.type !== "toolCall") break;
            let toolName = block.name as AiToolCall["toolName"];
            if (toolName !== "writeFile" && toolName !== "editFile") {
              session.codePreviewManager.clearActiveFile();
            }
            session.emitStreamEvent({
              type: "toolCallStarted",
              toolCallId: block.id,
              toolName,
            });
            session.codePreviewManager.startToolCall(block.id, toolName);
            session.executeCodeStreamManager.startToolCall(block.id, toolName);
            break;
          }
          case "toolcall_delta": {
            // Raw JSON fragments -- the same feed the streaming input parsers always consumed.
            let block = ev.partial.content[ev.contentIndex];
            if (block?.type !== "toolCall") break;
            session.codePreviewManager.appendInput(block.id, ev.delta);
            session.executeCodeStreamManager.appendInput(block.id, ev.delta);
            break;
          }
          case "toolcall_end":
            session.codePreviewManager.finishToolCall(ev.toolCall.id, true);
            session.executeCodeStreamManager.finishToolCall(ev.toolCall.id);
            // executeCode's completion is deferred until it actually finishes executing (it can
            // take non-trivial time and streams its output); see tool_execution_end below.
            if (ev.toolCall.name !== "executeCode") {
              session.emitStreamEvent({type: "toolCallFinished", toolCallId: ev.toolCall.id});
            }
            break;
        }
        break;
      }

      case "tool_execution_end":
        // The one chokepoint that sees every failed call -- including schema-validation
        // failures, blocked calls, and aborts, which never reach the tool's own execute() -- so
        // withdraw failed edits' previews here. A failed call appends no change row, and nothing
        // else would supersede its preview. (Successful calls need no withdrawal: their row
        // does; see AiChatStreamEvent's editPreviewClear.)
        if (event.isError) {
          session.codePreviewManager.clearPreview(event.toolCallId);
        }
        if (event.toolName === "executeCode") {
          session.emitStreamEvent({type: "toolCallFinished", toolCallId: event.toolCallId});
        }
        if (!executedToolCalls.delete(event.toolCallId)) {
          traceRejectedToolCall(Object.hasOwn(tools, event.toolName) ? event.toolName : undefined,
              event.toolCallId, abortSignal.aborted);
        }
        break;

      case "turn_end": {
        // The persistence barrier: one durable chat-log step per completed model turn. The loop
        // awaits this before starting the next request, so the log can never fall behind what
        // the model has seen.
        let message = event.message as AssistantMessage;
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          // Persist nothing from a failed or cancelled model request; retried or rethrown after
          // the loop returns.
          turnFailure = message;
          break;
        }
        // Note: a turn the model completed is persisted even if the user cancelled while its
        // tools were executing -- the completed calls' buffered edits and captured
        // actions/connection requests land with their records here (effects iff record, the
        // invariant this barrier exists for), rather than evaporating out from under side
        // effects the next turn would mis-consume. Tool calls the abort kept from running are
        // recorded as errors below, and finishTurn ends the loop right after this barrier.

        let msgs: AiChatMessageBodyWithModelData[] = [];

        {
          let msg: AiChatMessageBodyWithModelData = {
            type: "message",
            message: message.content.filter(block => block.type === "text")
                .map(block => block.text).join(""),
          };
          let reasoning = message.content
              .flatMap(block =>
                  block.type === "thinking" && !block.redacted ? [block.thinking] : [])
              .join("\n\n");
          if (reasoning) {
            msg.reasoning = reasoning;
          }
          let toolCallBlocks = message.content.filter(block => block.type === "toolCall");
          if (toolCallBlocks.length > 0) {
            let resultsById = new Map(event.toolResults.map(r => [r.toolCallId, r]));
            msg.toolCalls = toolCallBlocks.map(block => {
              let result = <AiToolCall>{
                toolCallId: block.id,
                toolName: block.name as AiToolCall["toolName"],
                input: block.arguments,
              };
              let toolResultMsg = resultsById.get(block.id);
              if (!toolResultMsg) {
                // A cancellation broke the tool batch before this call could run (the only way
                // a completed turn's tool call lacks a result). Record the same error pi reports
                // for a call an abort pre-empted, so replay shows the model an honest failure
                // rather than a fabricated success (or a missing tool result, which providers
                // reject).
                result.error = "Operation aborted";
              } else if (toolResultMsg.isError) {
                // The result text is pi's rendering of the failure (thrown tool errors, schema
                // validation failures, unknown tools). Our own tools' catch blocks record the
                // same text via session.toolCallNotes (merged below), along with extra bookkeeping like
                // observedCodeVersion.
                result.error = toolResultMsg.content
                    .map(part => part.type === "text" ? part.text : "").join("") ||
                    "Tool call failed.";
              } else if (toolResultMsg.details) {
                // Success notes (observedCodeVersion, recorded output) ride the result's details.
                Object.assign(result, toolResultMsg.details);
              }
              let notes = session.toolCallNotes.get(block.id);
              if (notes) {
                Object.assign(result, notes);
              }
              return result;
            });
          }

          // The model-facing snapshot rides along for the overseer to persist beside the display
          // record.
          msg.modelData = makeStoredAssistantMessage(message);
          msgs.push(msg);
        }

        let capturedActions = capturedActionsForStep;
        capturedActionsForStep = undefined;
        if (capturedActions) {
          for (let actionId of capturedActions.actions) {
            msgs.push({type: "action", actionId});
          }
          if (capturedActions.accessedGadget) {
            msgs.push({type: "useGadget"});
          }
        }

        // Append any connection requests the agent made this step, after the assistant message
        // that contains the requestConnection tool call (so ordering reads correctly).
        for (let cr of hooks.consumeCapturedConnectionRequests(chatId)) {
          msgs.push(cr);
        }

        // The barrier itself: one transaction persists the step's messages and its buffered
        // effects -- rows, the step's single "changes" message, retirement, registry stamps --
        // so the effects are durable iff the transcript that explains them is. The buffer is
        // drained before the call. If the barrier throws, the turn dies with it, and re-delivering
        // the effects would be wrong.
        await session.persistStep(async () => {
          let stepChanges = session.stepBuffer.changes;
          session.stepBuffer.changes = [];
          session.stepBuffer.bytes = 0;
          let createdGadgets = session.pendingCreatedGadgets;
          session.pendingCreatedGadgets = [];
          let createdWorktrees = session.pendingCreatedWorktrees;
          session.pendingCreatedWorktrees = [];
          let addedBindings = session.pendingAddedBindings;
          session.pendingAddedBindings = [];
          let worktreeCommits = session.pendingWorktreeCommits;
          session.pendingWorktreeCommits = [];
          let blueprintMerges = session.pendingBlueprintMerges;
          session.pendingBlueprintMerges = [];
          if (await hooks.commitAgentStep(chatId, author, msgs,
              {changes: stepChanges, createdGadgets, createdWorktrees, addedBindings,
               worktreeCommits, blueprintMerges},
              message.usage, handle.lastResponse?.aiGatewayLogId, handle.aiGatewayLogRoute)) {
            ++session.nextChangeId;
          }
        });

        // Reset per-step streaming state.
        session.toolCallNotes.clear();
        session.executeCodeStreamManager.clear();
        break;
      }
    }
  };

  // Every request of this pass leads with the system prompt and the tools.
  let leadingSystemMessage: SystemMessage = {
    ...systemMessage, toolsAdded: toolList.map(toToolDeclaration),
  };
  // A checkpoint Anthropic wrote reaches a model that can read it as its block, and any other
  // model as the summary text.
  let stream = session.priorConversation !== undefined &&
      checkpoint?.anthropicCompactionBlock !== undefined &&
      supportsAnthropicCompaction(handle.model)
    ? withAnthropicCompactionBlock(
        handle.stream, checkpoint.anthropicCompactionBlock, session.priorConversation)
    : handle.stream;

  // Compaction runs once the tools exist, because Anthropic summarizes the request a turn would
  // send. Defining the tools has no effects, so nothing has acted when a `/compact` turn returns.
  let compactionTurn = isCompactionTurn(chatMessages);
  if (compactionTurn || shouldCompactChat(contextTokens, inputBudget)) {
    let compactedTo = findCompactionBoundary(
        projection, inputBudget, contextTokens,
        checkpoint?.compactedTo, findProtectedFromSequence(chatMessages));
    if (compactedTo !== undefined) {
      session.emitStreamEvent({type: "compacting"});
      try {
        let written: Pick<CompactionCheckpoint, "summary" | "anthropicCompactionBlock">;
        if (supportsAnthropicCompaction(handle.model)) {
          // The summarized messages are the prompt up to the boundary; the rest stays verbatim.
          let keptFrom = projection.findIndex(({sequence}) =>
            sequence !== undefined && sequence >= compactedTo);
          let {summary, block} = await requestAnthropicCompaction(
              handle, stream,
              {messages: [leadingSystemMessage, ...session.modelMessages.slice(0, keptFrom)]},
              COMPACTION_SYSTEM_PROMPT, {maxTokens: maxOutputTokens, signal: abortSignal});
          written = {summary, anthropicCompactionBlock: block};
        } else {
          let summaryMessages = buildSummaryPrompt(projection, compactedTo, handle.model);
          summaryMessages.push({
            role: "user",
            content: "Create the context handoff now. Do not continue the conversation.",
            timestamp: Date.now(),
          });
          // Like title generation, this call's usage is deliberately not billed to the chat. It
          // carries the turn's largest prompt, so it needs the response cap most: without it a
          // model that charges the response to the same window would reject the request outright.
          let summary = (await completeText(handle, {
            systemPrompt: COMPACTION_SYSTEM_PROMPT,
            messages: summaryMessages,
            maxTokens: maxOutputTokens,
            signal: abortSignal,
          })).trim();
          // An empty summary would discard the compacted history, so keep the history instead.
          if (!summary) throw new Error("Compaction produced an empty summary.");
          written = {summary};
        }

        let compacted: CompactionCheckpoint = {
          chatId,
          compactedTo,
          ...written,
          // The pruned history can no longer describe gadgets created mid-thread, so
          // compaction refreshes the listing (computing it now if this pass reused the
          // persisted snapshot). Spawner chats carry no listing -- their prompt branch shows
          // configured bindings instead -- so they keep an absent one, as before.
          workspacePrompt: session.agentContext.spawnerConfig
              ? undefined
              : systemPromptWorkspace ?? await computeWorkspaceSection(),
          alwaysAvailableResources: [
            ...seenAlwaysAvailableResources(session.listedResources, chatMessages, compactedTo).values(),
          ],
          ...buildCompactionState(
              chatMessages,
              compactedTo,
              session.seedBindings.map<[string, ChatBindingEntry]>(seed => [
                seed.name,
                {type: "workpiece", id: seed.target},
              ]),
              checkpoint),
        };
        return {type: "compacted", checkpoint: compacted};
      } catch (error) {
        // Compaction triggers below the limit, so the turn's own prompt still fits and a failed
        // summary must not fail the turn. Cancellation and an explicit `/compact` do surface.
        abortSignal.throwIfAborted();
        if (compactionTurn) throw error;
        logger.warn("compaction failed; running the turn without it", {
          event: "agent.compaction.failed", chatId, error,
        });
      } finally {
        session.emitStreamEvent({type: "compacted"});
      }
    } else if (compactionTurn) {
      // An automatic attempt that finds no boundary just runs the turn, but `/compact` returns
      // below without prompting the model, so without this the command would do nothing visible.
      session.emitStreamEvent({type: "compacted", nothingToCompact: true});
    }
  }
  // `/compact` ends the turn whether or not the boundary could advance; the model is never prompted.
  if (compactionTurn) return {type: "finished"};

  if (session.modelMessages.length === 0 ||
      session.modelMessages[session.modelMessages.length - 1].role === "assistant") {
    // The log tail ends with a completed assistant response and nothing new has arrived for
    // the model to answer (e.g. the previous turn crashed between persisting its final message
    // and finishing), so there is nothing to run. pi's loop requires the context to end with a
    // user or session.toolResult message, which replay otherwise guarantees.
    logger.warn("agent turn skipped: history ends with a completed assistant message", {
      event: "agent.turn.skipped", chatId,
    });
    return {type: "finished"};
  }

  // Report the catalogs that changed since the model last saw them. The record is the newest, so
  // every earlier request stays a prefix of this one. It must not be written before the returns
  // above: a `/compact` or skipped turn would then no longer be recognized as one.
  let catalogChanges = findCatalogChanges(
      seenAlwaysAvailableResources(session.listedResources, chatMessages, Infinity), session.currentResources);
  if (catalogChanges.length > 0) {
    let sequence = hooks.nextChatSequencePeek(chatId);
    hooks.addChatMessages(chatId, author, [{type: "catalogChange", resources: catalogChanges}]);
    session.replayCatalogChange(sequence, catalogChanges, Date.now());
  }

  let context: AgentContext = {
    messages: [leadingSystemMessage, ...session.modelMessages],
    tools: toolList,
  };

  await runAgentLoopContinue(context, {
    model: handle.model,
    // Replay already produces LLM-shaped messages; no custom message types exist. The system
    // prompt and tool declarations now ride the leading system message in pi's transcript.
    convertToLlm: (messages) => messages as Message[],
    toolExecution: "sequential",
    getSteeringMessages: async () => hooks.takeSteers(chatId).map(
        text => ({role: "user" as const, content: text, timestamp: Date.now()})),
    maxTokens: maxOutputTokens,
    finishTurn: ({message, toolResults}) => {
      if (message.stopReason === "error" || message.stopReason === "aborted") return;
      capturedActionsForStep = hooks.consumeCapturedActions(chatId);
      if (capturedActionsForStep?.awaitDecision) session.awaitingActionDecision = true;
      // The next request is this step's measured prompt plus the tool results just produced,
      // weighed as the model will see them (pi's `details` can carry a second copy of a large
      // output). Without usage there is nothing to measure against.
      let measured = message.usage.totalTokens;
      nextRequestFits = measured > 0 && !shouldCompactChat(measured + estimateProjectionTokens(
          toolResults.map(({details: _, ...message}) => ({message}))), inputBudget);
      // The stop reasons that end the turn come first: a compaction reload must not resume work
      // that one of them ended.
      if (
          // Cancelled during tool execution: turn_end will persist the completed turn before
          // this decision ends the loop; don't start another (doomed) model request.
          abortSignal.aborted ||
          // End the turn once the agent has successfully requested a connection: it must wait
          // for the user to respond, not keep reasoning in the meantime. (Accept resumes it on a
          // fresh turn; deny just leaves the turn ended.) A rejected requestConnection (e.g.
          // unresolvable resource) leaves this false so the agent can fix the request and retry
          // in the same turn.
          session.connectionRequested ||
          // Wait for approval before continuing against state that may not reflect the action.
          session.awaitingActionDecision) {
        return {action: "end"};
      }
      // The model stopped on its own; there is no next request to make room for.
      if (toolResults.length === 0) return;
      // Otherwise reload when that request won't fit, or can't be measured: the turn-start check
      // then estimates the whole prompt, as it does for that case there.
      if (!nextRequestFits) {
        reloadForCompaction = true;
        // The rerun's fresh preview manager knows of no active file; end this one's marker here,
        // as a non-edit tool start would, so it doesn't outlive the run on the client.
        session.codePreviewManager.clearActiveFile();
        return {action: "end"};
      }
    },
  }, emit, abortSignal, stream);

  // (No end-of-turn flush: every completed step's effects were barrier-committed with its
  // message, and an abort simply drops the in-flight step's buffer -- nothing durable exists
  // for it. Cancellation stops the agent, it does not revert the turn; completed steps' work
  // stays, and the user reverts explicitly if they want it gone.)

  // Cancellation surfaces as the abort reason, matching the old thrown-abort behavior. (Checked
  // outside turnFailure because an abort during tool execution stops the loop after a persisted,
  // *completed* turn -- no failed model request happened.)
  abortSignal.throwIfAborted();

  if (turnFailure) {
    // Other failures become an AgentTurnError carrying the failing request's HTTP status (when
    // it can be determined) for the overseer's triage; runAgent retries a transient one first.
    let message = turnFailure.errorMessage ?? "The model request failed.";
    let error = new AgentTurnError(message, httpStatusFromError(message, handle.lastResponse));
    if (isRetryableAssistantError(turnFailure)) return {type: "transientFailure", error};
    throw error;
  }

  if (reloadForCompaction) return {type: "reloadForCompaction"};
  return {type: "finished", lastRequest: nextRequestFits ? handle.lastRequest : undefined};
}


// =======================================================================================
// Agent callback args processing utilities.

// Checks if a value is a plain object (not a class instance, not a native type).
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  let proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Produces a depth-limited summary string for callback args. Stubs and large content are
 * replaced with placeholders.
 */
export function summarizeArgs(args: unknown[]): string {
  return args.map((arg, i) => `[${i}]: ${summarizeValue(arg, 0)}`).join("\n");
}

// Summarize the content of params passed to an agent callback. This is presented to the agent
// in the chat log, but the agent can use executeCode to get access to the full value. If the
// value has a lot of data, we don't want to bloat the agent's context with it, but we also don't
// want to truncate too excessively as it forces the agent to perform round trips with
// executeCode.
// TODO: summarizeValue() can probably be optimized further. We also need to experiment with how
//   to best explain to the agent that it's seeing something truncated -- I've noticed the "..."
//   confuses it a bit.
function summarizeValue(value: unknown, depth: number): string {
  if (depth > 3) return "...";

  if (value === null) return "null";
  if (value === undefined) return "undefined";

  switch (typeof value) {
    case "string":
      if (value.length > 100) return JSON.stringify(value.slice(0, 100) + "...");
      return JSON.stringify(value);
    case "number":
    case "boolean":
      return String(value);
    case "bigint":
      return `${value}n`;
  }

  if (value instanceof NativeRpcStub) return "RpcStub";
  // @ts-ignore RPC types cause excessively deep instantiation (a known bug in the Workers RPC
  //   types: `RpcStub<any>` is infinitely recursive). The error is reported once, at whichever
  //   line first triggers it -- here, on the narrowing that follows the instanceof check above.
  if (value instanceof Date) return `Date("${value.toISOString()}")`;
  if (value instanceof Uint8Array) return `Uint8Array(${value.length})`;

  // TODO: Export ServiceStub from cloudflare:workers so we can represent it here. For now we
  //   guess that it's a stub if it has the constructor name "Fetcher".
  if (typeof value === "object" && value.constructor?.name === "Fetcher") {
    return "ServiceStub";
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    let maxItems = 30;
    let items = value.slice(0, maxItems).map(v => summarizeValue(v, depth + 1));
    if (value.length > maxItems) items.push(`...${value.length - maxItems} more`);
    return `[${items.join(", ")}]`;
  }

  if (isPlainObject(value)) {
    let keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    let maxKeys = 15;
    let entries = keys.slice(0, maxKeys).map(
        k => `${k}: ${summarizeValue(value[k], depth + 1)}`);
    if (keys.length > maxKeys) entries.push(`...${keys.length - maxKeys} more`);
    return `{${entries.join(", ")}}`;
  }

  // Other native objects
  if (typeof value === "object") return `${value.constructor?.name ?? "object"}`;

  return String(value);
}
