import {
  Blueprint,
  File as FileIcon,
  GitBranch,
  Globe,
  Lightning,
  LinkSimple,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  Question,
  Robot,
  Terminal,
} from "@phosphor-icons/react";
import type { AiToolCall, BlueprintOutput, WorkpieceId } from "@gadgets/workshop-shared/api";
import { FORMAT_ICONS } from "../../../components/format/formats";
import type { ProvisionalToolCallState } from "../provisionalChatState";
import type { ObservationChatMessage } from "./messageTypes";

/** Any icon the transcript draws for a tool call. */
export type PhosphorIcon = typeof MagnifyingGlass;

// Names the binding edge a gadget-binding tool call touched, as `GADGET.BINDING` when the record
// says which gadget owns it. (Records written before named chat bindings carry only the binding
// name, and a still-streaming call may not have either yet.)
function formatGadgetBindingTarget(
  gadget: string | undefined,
  name: string | undefined,
): string | undefined {
  if (!name) return gadget;
  return gadget ? `${gadget}.${name}` : name;
}
/**
 * What a `createGadget` call produced. Read from the gadget's own stamped output rather than
 * re-derived from the blueprint, so any blueprint declaring a format counts, not just promoted
 * ones. Undefined for a plain gadget, a still-streaming call, or a log predating formats.
 */
export type ToolOutputResolver = (tc: AiToolCall) => BlueprintOutput | undefined;

/**
 * What a finished `createGadget` call produced, read from the gadget's own stamped output
 * (see ToolOutputResolver); undefined for anything else.
 */
export function resolveToolCallOutput(
  tc: AiToolCall,
  outputOfWorkpiece: (gadgetId: WorkpieceId) => BlueprintOutput | undefined,
): BlueprintOutput | undefined {
  if (tc.toolName !== "createGadget") return undefined;
  const gadgetId = (tc.output as { gadgetId?: unknown } | undefined)?.gadgetId;
  return typeof gadgetId === "number" ? outputOfWorkpiece(gadgetId) : undefined;
}

/**
 * Resolves a tool call's stamped output via the chat's workpiece lookup (a bound
 * `resolveToolCallOutput`); the transcript passes it down so grouped rows can name a Doc.
 */
export function toolOutputResolver(
  outputOfWorkpiece: (gadgetId: WorkpieceId) => BlueprintOutput | undefined,
): ToolOutputResolver {
  return (tc) => resolveToolCallOutput(tc, outputOfWorkpiece);
}

/** The `{verb, target}` summary a tool-call row shows for one call. */
export function getToolCallSummary(
  tc: AiToolCall,
  outputOf?: ToolOutputResolver,
): { verb: string; target?: string } {
  switch (tc.toolName) {
    case "readFile":
      return { verb: "Read", target: tc.input.filename };
    case "writeFile":
      return { verb: "Wrote", target: tc.input.filename };
    case "editFile":
      return { verb: "Edited", target: tc.input.filename };
    case "grep":
      return { verb: "Searched", target: tc.input.path ?? tc.input.workpiece };
    case "describeBinding":
      return {
        verb: "Inspected",
        target: tc.input.gadget === undefined
          ? `${String(tc.input.name)} binding`
          : `${String(tc.input.name)} binding of ${tc.input.gadget}`,
      };
    case "setBindingHook":
      return {
        verb: "Connected",
        target: tc.input.entrypoint
          ? `${tc.input.bindingName} → ${tc.input.entrypoint}`
          : tc.input.bindingName,
      };
    case "setGadgetBinding":
      return {
        verb: "Wired up",
        target: formatGadgetBindingTarget(tc.input.gadget, tc.input.name ?? tc.input.source),
      };
    // Obsolete predecessor of `setGadgetBinding`; appears only in old chat logs.
    case "saveCapsuleAsBinding":
      return { verb: "Saved resource", target: tc.input.bindingName };
    case "createGadget": {

      const output = outputOf?.(tc);
      return { verb: `Created ${output?.noun ?? "gadget"}`, target: tc.input.title };
    }
    case "createWorktree":
      return { verb: "Created worktree", target: tc.input.title };
    case "executeCode": {
      // Prefer the first non-empty line as a preview. `code` may be absent while the tool call's
      // input is still streaming in, so guard against undefined.
      const firstLine = tc.input.code
        ?.split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      return {
        verb: "Ran code",
        target: firstLine
          ? firstLine.length > 60
            ? `${firstLine.slice(0, 57)}…`
            : firstLine
          : undefined,
      };
    }
    case "giveUp":
      return { verb: "Stopped" };
    case "webFetch": {
      let target = tc.input.url;
      try {
        target = new URL(tc.input.url).host;
      } catch {
        // Leave as the raw URL.
      }
      return { verb: "Fetched", target };
    }
    case "observeUserChanges":
      return { verb: "Observed user changes" };
    case "listBlueprints":
      return { verb: "Listed blueprints" };
    case "listConnectableResources":
      return { verb: "Listed connectable resources", target: tc.input.vendorId };
    case "requestConnection":
      return { verb: "Requested connection", target: tc.input.vendorId };
    case "createExternalResource":
      return { verb: "Created", target: tc.input.title };
    case "activateSkill":
      return { verb: "Activated skill", target: tc.input.skill };
    case "delegateToBot":
      return { verb: "Delegated to bot", target: tc.input.bot };
    case "messageBot":
      return { verb: "Sent direct message", target: tc.input.to };
  }
  // Compile-time exhaustiveness check.
  const _exhaustive: never = tc;
  return { verb: (_exhaustive as { toolName: string }).toolName };
}

function lowerFirst(text: string): string {
  return text ? text[0].toLowerCase() + text.slice(1) : text;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatTimes(count: number): string {
  return pluralize(count, "time");
}

function describeObservationCount(count: number): string {
  return count === 1 ? "Read 1 resource" : `${count} resource reads`;
}

function describeToolCallCount(toolName: AiToolCall["toolName"], count: number): string {
  switch (toolName) {
    case "readFile":
      return `Read ${pluralize(count, "file")}`;
    case "writeFile":
      return `Wrote ${pluralize(count, "file")}`;
    case "editFile":
      return count === 1 ? "Made 1 edit" : `Made ${count} edits`;
    case "grep":
      return count === 1 ? "Searched files" : `Searched files ${formatTimes(count)}`;
    case "webFetch":
      return `Fetched ${pluralize(count, "page")}`;
    case "executeCode":
      return count === 1 ? "Ran code" : `Ran code ${formatTimes(count)}`;
    case "describeBinding":
      return `Inspected ${pluralize(count, "binding")}`;
    case "setBindingHook":
      return `Connected ${pluralize(count, "binding")}`;
    case "setGadgetBinding":
      return `Wired up ${pluralize(count, "binding")}`;
    case "saveCapsuleAsBinding":
      return `Saved ${pluralize(count, "resource")}`;
    case "createGadget":
      return `Created ${pluralize(count, "gadget")}`;
    case "createWorktree":
      return `Created ${pluralize(count, "worktree")}`;
    case "observeUserChanges":
      return `Observed ${pluralize(count, "change set")}`;
    case "giveUp":
      return count === 1 ? "Stopped" : `Stopped ${count} times`;
    case "listBlueprints":
      return `Listed blueprints`;
    case "listConnectableResources":
      return `Listed connectable resources`;
    case "requestConnection":
      return count === 1 ? "Requested a connection" : `Requested ${count} connections`;
    case "createExternalResource":
      return `Created ${pluralize(count, "external resource")}`;
    case "activateSkill":
      return `Activated ${pluralize(count, "skill")}`;
    case "delegateToBot":
      return count === 1 ? "Delegated to a bot" : `Delegated ${count} subtasks`;
    case "messageBot":
      return `Sent ${pluralize(count, "direct message")}`;
  }
  const _exhaustive: never = toolName;
  return _exhaustive;
}

// `output` names a format when the call is known to be producing one, so the row can use its icon.
/** The icon a tool-call row draws for the call. */
export function getToolIcon(
  toolName: AiToolCall["toolName"] | null | undefined,
  output?: BlueprintOutput,
): PhosphorIcon {
  if (output) return FORMAT_ICONS[output.icon];
  switch (toolName) {
    case "readFile":
    case "writeFile":
      return FileIcon;
    case "editFile":
      return PencilSimple;
    case "executeCode":
      return Terminal;
    case "webFetch":
      return Globe;
    case "grep":
    case "describeBinding":
      return MagnifyingGlass;
    case "setBindingHook":
    case "setGadgetBinding":
    case "saveCapsuleAsBinding":
      return LinkSimple;
    case "createGadget":
      return Plus;
    case "createWorktree":
      return GitBranch;
    case "listBlueprints":
      return Blueprint;
    case "observeUserChanges":
      return MagnifyingGlass;
    case "giveUp":
      return Question;
    case "activateSkill":
      return Lightning;
    case "delegateToBot":
    case "messageBot":
      return Robot;
    default:
      return Question;
  }
}

function getProvisionalToolLabel(toolName: AiToolCall["toolName"] | null | undefined) {
  switch (toolName) {
    case "readFile":
      return "Reading file";
    case "writeFile":
      return "Writing file";
    case "editFile":
      return "Editing file";
    case "grep":
      return "Searching files";
    case "describeBinding":
      return "Inspecting binding";
    case "setBindingHook":
      return "Connecting binding";
    case "setGadgetBinding":
      return "Wiring up binding";
    case "saveCapsuleAsBinding":
      return "Saving resource";
    case "createGadget":
      return "Creating gadget";
    case "createWorktree":
      return "Creating worktree";
    case "executeCode":
      return "Running code";
    case "webFetch":
      return "Fetching web page";
    case "observeUserChanges":
      return "Observing user changes";
    case "giveUp":
      return "Stopping";
    default:
      return "Using tool";
  }
}

function getToolTarget(tc: AiToolCall): string | undefined {
  return getToolCallSummary(tc).target;
}

// Present-tense verb for an in-progress tool call.
function getProvisionalToolVerb(toolName: AiToolCall["toolName"]): string {
  switch (toolName) {
    case "readFile": return "Reading";
    case "writeFile": return "Writing";
    case "editFile": return "Editing";
    case "grep": return "Searching";
    case "describeBinding": return "Inspecting";
    case "setBindingHook": return "Connecting";
    case "setGadgetBinding": return "Wiring up";
    case "saveCapsuleAsBinding": return "Saving";
    case "createGadget": return "Creating gadget";
    case "createWorktree": return "Creating worktree";
    case "executeCode": return "Running code";
    case "webFetch": return "Fetching";
    case "observeUserChanges": return "Observing user changes";
    case "giveUp": return "Stopping";
    case "listBlueprints": return "Listing blueprints";
    case "listConnectableResources": return "Listing connectable resources";
    case "requestConnection": return "Requesting a connection";
    case "createExternalResource": return "Creating external resource";
    case "activateSkill": return "Activating a skill";
    case "delegateToBot": return "Delegating to a bot";
    case "messageBot": return "Sending a direct message";
  }
  const _exhaustive: never = toolName;
  return _exhaustive;
}

// Present-tense, count-aware label mirroring describeToolCallCount (e.g. "Writing 5 files").
function describeProvisionalToolCount(toolName: AiToolCall["toolName"], count: number): string {
  if (count <= 1) return getProvisionalToolLabel(toolName);
  switch (toolName) {
    case "readFile": return `Reading ${pluralize(count, "file")}`;
    case "writeFile": return `Writing ${pluralize(count, "file")}`;
    case "editFile": return `Making ${count} edits`;
    case "grep": return `Searching files ${formatTimes(count)}`;
    case "webFetch": return `Fetching ${pluralize(count, "page")}`;
    case "executeCode": return count === 1 ? "Running code" : `Running code ${formatTimes(count)}`;
    case "describeBinding": return `Inspecting ${pluralize(count, "binding")}`;
    case "setBindingHook": return `Connecting ${pluralize(count, "binding")}`;
    case "setGadgetBinding": return `Wiring up ${pluralize(count, "binding")}`;
    case "saveCapsuleAsBinding": return `Saving ${pluralize(count, "resource")}`;
    case "createGadget": return `Creating ${pluralize(count, "gadget")}`;
    case "createWorktree": return `Creating ${pluralize(count, "worktree")}`;
    case "observeUserChanges": return `Observing ${pluralize(count, "change set")}`;
    case "giveUp": return "Stopping";
    case "listBlueprints": return "Listing blueprints";
    case "listConnectableResources": return "Listing connectable resources";
    case "requestConnection": return `Requesting ${pluralize(count, "connection")}`;
    case "createExternalResource": return `Creating ${pluralize(count, "external resource")}`;
    case "activateSkill": return `Activating ${pluralize(count, "skill")}`;
    case "delegateToBot": return `Delegating ${pluralize(count, "subtask")}`;
    case "messageBot": return `Sending ${pluralize(count, "direct message")}`;
  }
  const _exhaustive: never = toolName;
  return _exhaustive;
}

/**
 * Whether a tool call is still waiting for its result. Only a tool that records an `output` can
 * be told apart from a finished call (a writeFile's record looks the same done or not), so calls
 * of the other tools count as finished; an errored call is finished too -- its row shows the
 * Error pill, never a spinner.
 */
export function isToolCallRunning(tc: AiToolCall): boolean {
  if (tc.error) return false;
  switch (tc.toolName) {
    case "grep":
    case "describeBinding":
    case "setGadgetBinding":
    case "createGadget":
    case "createWorktree":
    case "executeCode":
    case "webFetch":
    case "listBlueprints":
    case "listConnectableResources":
    case "requestConnection":
    case "activateSkill":
    case "delegateToBot":
    case "messageBot":
    case "createExternalResource":
      return tc.output === undefined;
    case "readFile":
    case "writeFile":
    case "editFile":
    case "setBindingHook":
    case "saveCapsuleAsBinding":
    case "giveUp":
    case "observeUserChanges":
      return false;
  }
  // Compile-time exhaustiveness check: a new AiToolCall variant must join one of the groups
  // above, or one that declares `output` would silently read as finished while it still runs.
  const _exhaustive: never = tc;
  return _exhaustive;
}

/**
 * Builds the label + detail lines for the in-progress tool-call row.
 */
export function buildProvisionalToolSummary(
  calls: ProvisionalToolCallState[],
): { label: string; detailLines: string[]; running: boolean } {
  if (calls.length === 0) {
    return { label: "Using tool", detailLines: [], running: false };
  }
  if (calls.length === 1 && calls[0].outputFormat) {
    return { label: `Creating ${calls[0].outputFormat.noun}`, detailLines: [], running: !calls[0].finished };
  }
  const toolNames = Array.from(
    new Set(calls.map((c) => c.toolName).filter((n): n is AiToolCall["toolName"] => !!n)),
  );
  const detailLines = Array.from(
    new Set(calls.map((c) => c.target).filter((t): t is string => Boolean(t))),
  );

  if (toolNames.length === 0) {
    return { label: "Using tool", detailLines: [], running: !calls[calls.length - 1].finished };
  }

  if (toolNames.length > 1) {
    const parts = toolNames.map((toolName) =>
      describeProvisionalToolCount(
        toolName,
        calls.filter((c) => c.toolName === toolName).length,
      ),
    );
    return {
      label: parts.map((part, i) => (i === 0 ? part : lowerFirst(part))).join(", "),
      detailLines,
      running: !calls[calls.length - 1].finished,
    };
  }

  const toolName = toolNames[0];
  if (calls.length === 1) {
    const target = detailLines[0];
    return {
      label: target ? `${getProvisionalToolVerb(toolName)} ${target}` : getProvisionalToolLabel(toolName),
      detailLines: [],
      running: !calls[0].finished,
    };
  }

  const label =
    detailLines.length === 1
      ? `${getProvisionalToolVerb(toolName)} ${detailLines[0]}`
      : describeProvisionalToolCount(toolName, calls.length);
  return { label, detailLines, running: !calls[calls.length - 1].finished };
}

/**
 * One collapsible row of a transcript's work run: the calls and observations a stretch of agent
 * work produced, summarized into one label with a disclosure of the individual calls.
 */
export type ToolCallGroup = {
  key: string;
  Icon: PhosphorIcon;
  label: string;
  detailLines: string[];
  calls: AiToolCall[];
  observations: ObservationChatMessage[];
  hasError: boolean;
  /**
   * Whether the group's latest call is still waiting for its result. False whenever the group has
   * an error: the Error pill speaks for the group, so the two never show together.
   */
  running: boolean;
};

/**
 * Collapse a run's tool calls and observations into the single group row the transcript shows
 * (one row per run; see buildChatDisplayEntries).
 */
export function buildToolCallGroups(
  toolCalls: AiToolCall[],
  observations: ObservationChatMessage[] = [],
  outputOf?: ToolOutputResolver,
): ToolCallGroup[] {
  if (toolCalls.length === 0 && observations.length === 0) return [];

  const distinctToolNames = Array.from(new Set(toolCalls.map((tc) => tc.toolName)));
  const targets = toolCalls
    .map((tc) => getToolTarget(tc))
    .filter((target): target is string => Boolean(target));
  const observationTargets = observations
    .map((msg) => msg.actionLog.resourceTitle)
    .filter((target): target is string => Boolean(target));
  const detailLines = Array.from(new Set([...targets, ...observationTargets]));
  const labelParts: string[] = [];

  if (toolCalls.length === 1) {
    const summary = getToolCallSummary(toolCalls[0], outputOf);
    labelParts.push(`${summary.verb}${summary.target ? ` ${summary.target}` : ""}`);
  } else if (toolCalls.length > 1 && distinctToolNames.length === 1) {
    const summary = getToolCallSummary(toolCalls[0], outputOf);
    labelParts.push(detailLines.length === 1 && summary.target && observations.length === 0
      ? `${summary.verb} ${summary.target}`
      : describeToolCallCount(toolCalls[0].toolName, toolCalls.length));
  } else if (toolCalls.length > 1 && distinctToolNames.length <= 3) {
    labelParts.push(...distinctToolNames.map((toolName) => {
      const count = toolCalls.filter((tc) => tc.toolName === toolName).length;
      return describeToolCallCount(toolName, count);
    }));
  } else if (toolCalls.length > 0) {
    labelParts.push(`${toolCalls.length} tool calls`);
  }

  if (observations.length > 0) {
    labelParts.push(describeObservationCount(observations.length));
  }

  const firstToolCall = toolCalls[0];
  const firstObservation = observations[0];
  const hasError = toolCalls.some((tc) => Boolean(tc.error));

  return [{
    // Use the first work item id so expansion survives streaming → committed.
    key: firstToolCall
      ? `group-${firstToolCall.toolCallId}`
      : `group-observation-${firstObservation.chatId}-${firstObservation.sequence}`,
    Icon: firstToolCall
      ? getToolIcon(firstToolCall.toolName, outputOf?.(firstToolCall))
      : MagnifyingGlass,
    label: labelParts
      .map((part, index) => index === 0 ? part : lowerFirst(part))
      .join(", "),
    detailLines,
    calls: toolCalls,
    observations,
    hasError,
    // Error wins over running, so a failed group shows the Error pill alone.
    running: !hasError && toolCalls.length > 0 && isToolCallRunning(toolCalls[toolCalls.length - 1]),
  }];
}

