import { AiChatAuthorInfo, AiToolCall, type AiModelConfig } from "@gadgets/workshop-shared/api";

import { createWorkshopLogger } from "./observability";
import {
  Type,
  getSystemMessageText,
  isRetryableAssistantError,
  toToolDeclaration,
} from "@earendil-works/pi-ai";
import type{ AssistantMessage, Message, SystemMessage } from "@earendil-works/pi-ai";
import { runAgentLoopContinue, type AgentContext, type AgentEvent } from "@earendil-works/pi-agent-core";
import { RpcStub as NativeRpcStub } from "cloudflare:workers";
import { seenAlwaysAvailableResources } from "./agent-catalog";
import { formatInstanceInstructions } from "./admin-config";
import { traceRejectedToolCall, traceTool } from "./agent-tracing";
import { AgentTurnError, completeText, httpStatusFromError } from "./ai-invoke";
import { buildTools, defineTool } from "./agent-tools";

import type{ AgentProgress } from "./agent-session";
import { COMMUNICATION_GUIDANCE, SYSTEM_PROMPT, SPAWNER_SYSTEM_PROMPT, SPAWNED_AGENT_TOOLS, SPAWNED_TASK_PROMPT, formatCallableAgentPrompt } from "./agent-prompt";
import { createTurnSession, makeStoredAssistantMessage } from "./agent-session";
import { replayChatLog } from "./agent-replay";
import type{ ChatHistory, AiChatMessageBodyWithModelData } from "./agent-hooks";
import type{ AgentHooks } from "./agent-hooks";

import { findCatalogChanges } from "./agent-catalog";
import type{ CachedRequest, ModelHandle } from "./ai-models";
import type{ ChatBindingEntry, CompactionCheckpoint } from "./storage-schema/overseer-storage";
import { buildCompactionState, buildSummaryPrompt, COMPACTION_SYSTEM_PROMPT, estimateProjectionTokens, findCompactionBoundary, findProtectedFromSequence, getModelTokenLimits, isCompactionTurn, shouldCompactChat, type CompactionProjectionMessage } from "./agent-compaction";
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

// =======================================================================================

// Locates `textToReplace` in `content`, enforcing editFile's exactly-one-match contract. The
// returned position is also where the live tool anchors its exact-span change.

/** The line window a readFile call asked for (see AiToolCall's readFile input). */

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

  await replayChatLog(
      {session, hooks, handle, chatId, chatMessages, checkpoint});

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
