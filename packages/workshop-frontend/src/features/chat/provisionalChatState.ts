import type { AiToolCall, BlueprintOutput } from "@gadgets/workshop-shared/api";
import type { ActiveFileTarget } from "./liveCodeStreams";

/**
 * One tool call the subscription is still streaming: its input's code and output accumulate
 * delta by delta until the durable message carrying the finished call arrives.
 */
export type ProvisionalToolCallState = {
  toolCallId: string;
  toolName: AiToolCall["toolName"] | null;
  /** Human-readable target (e.g. filename) once known from the streaming input. */
  target?: string;
  /**
   * For createGadget: what it is producing, once the server has resolved the blueprint. Tool inputs
   * aren't streamed, so this is the only way the row can name a Doc while it is still being made.
   */
  outputFormat?: BlueprintOutput;
  code: string;
  output: string;
  finished: boolean;
};

/**
 * A chat's still-streaming turn: the text and reasoning deltas, in-flight tool calls, and the
 * file the agent is actively editing, held outside React state because events arrive far faster
 * than renders (the chat store coalesces them; see store/chatStore).
 */
export type ProvisionalChatState = {
  text: string;
  reasoning: string;
  /** The turn is summarizing older context and can't produce output until it finishes. */
  compacting: boolean;
  toolCalls: ProvisionalToolCallState[];
  toolCallsById: Map<string, ProvisionalToolCallState>;
  activeEditingFile: ActiveFileTarget | null | undefined;
};

/** An empty provisional state, as a chat's turn begins. */
export function createProvisionalChatState(): ProvisionalChatState {
  return {
    text: "",
    reasoning: "",
    compacting: false,
    toolCalls: [],
    toolCallsById: new Map(),
    activeEditingFile: undefined,
  };
}

/**
 * Drop the streamed text, reasoning, and tool calls. Note: This function only clears chat
 * streaming state, not the active-file marker. Chat streaming is reset when a message arrives
 * (once per step); the active-file marker is reset when the finalized changes arrive (at the
 * end of a turn). (Streaming *code* needs no provisional state at all: agent edits arrive as
 * durable change rows via changeApplied.)
 */
export function clearProvisionalTextState(state: ProvisionalChatState) {
  state.text = "";
  state.reasoning = "";
  state.toolCalls = [];
  state.toolCallsById.clear();
}

/** Drop the active-file marker (see clearProvisionalTextState for the split). */
export function clearProvisionalCodeState(state: ProvisionalChatState) {
  state.activeEditingFile = undefined;
}

/** Whether nothing provisional remains to show for the chat. */
export function isProvisionalChatStateEmpty(state: ProvisionalChatState) {
  return (
    state.text === "" &&
    state.reasoning === "" &&
    !state.compacting &&
    state.toolCalls.length === 0 &&
    state.activeEditingFile === undefined
  );
}

/** The provisional tool call with this id, created (and named) if this is its first event. */
export function getOrCreateProvisionalToolCall(
  state: ProvisionalChatState,
  toolCallId: string,
  toolName: AiToolCall["toolName"] | null,
) {
  let toolCall = state.toolCallsById.get(toolCallId);
  if (toolCall) {
    if (toolName !== null) {
      toolCall.toolName = toolName;
    }
    return toolCall;
  }

  toolCall = {
    toolCallId,
    toolName,
    code: "",
    output: "",
    finished: false,
  };
  state.toolCallsById.set(toolCallId, toolCall);
  state.toolCalls.push(toolCall);
  return toolCall;
}
