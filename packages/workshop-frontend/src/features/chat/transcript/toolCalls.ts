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
  if (gadget === undefined) return name;
  if (name === undefined) return gadget;
  return `${gadget}.${name}`;
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

/** One tool's display data: every label, count phrase and icon its rows read. */
interface ToolMeta {
  /** Finished single-call verb; the call's target usually names the noun ("Read <file>"). */
  summary: string;
  /** Past-tense verb for count labels ("Read 2 files"). */
  past: string;
  /** What one call acts on, pluralized in count labels; omit when counts are a fixed phrase. */
  noun?: string;
  /** Irregular finished-count label (editFile's "Made N edits", grep's "…N times"). */
  countLabel?: (count: number) => string;
  /** Present-tense verb for in-progress labels ("Reading"). */
  present: string;
  /** Full present-tense phrase when one call's verb is one ("Creating gadget"). */
  presentPhrase?: string;
  /** Standalone in-progress label when the streaming call has no target yet. Tools that never
   * got one keep the generic "Using tool" (their single-call placeholder predates them). */
  presentLabel?: string;
  /** Irregular in-progress count label (grep's "Searching files N times"). */
  presentCountLabel?: (count: number) => string;
  /** The icon a tool-call row draws for the tool. */
  icon: PhosphorIcon;
  /** Whether a running call is recognized by its missing `output` (see isToolCallRunning). */
  runningNeedsOutput: boolean;
}

// The one table every tool-call label, count and icon derives from: adding a tool is one row
// here (the Record type forces it), not seven parallel switches.
const TOOL_META: Record<AiToolCall["toolName"], ToolMeta> = {
  readFile: {
    summary: "Read",
    past: "Read",
    noun: "file",
    present: "Reading",
    presentLabel: "Reading file",
    icon: FileIcon,
    runningNeedsOutput: false,
  },
  writeFile: {
    summary: "Wrote",
    past: "Wrote",
    noun: "file",
    present: "Writing",
    presentLabel: "Writing file",
    icon: FileIcon,
    runningNeedsOutput: false,
  },
  editFile: {
    summary: "Edited",
    past: "Edited",
    countLabel: (count) => `Made ${pluralize(count, "edit")}`,
    present: "Editing",
    presentLabel: "Editing file",
    presentCountLabel: (count) => `Making ${pluralize(count, "edit")}`,
    icon: PencilSimple,
    runningNeedsOutput: false,
  },
  grep: {
    summary: "Searched",
    past: "Searched",
    countLabel: (count) =>
      count === 1 ? "Searched files" : `Searched files ${formatTimes(count)}`,
    present: "Searching",
    presentLabel: "Searching files",
    presentCountLabel: (count) => `Searching files ${formatTimes(count)}`,
    icon: MagnifyingGlass,
    runningNeedsOutput: true,
  },
  describeBinding: {
    summary: "Inspected",
    past: "Inspected",
    noun: "binding",
    present: "Inspecting",
    presentLabel: "Inspecting binding",
    icon: MagnifyingGlass,
    runningNeedsOutput: true,
  },
  setBindingHook: {
    summary: "Connected",
    past: "Connected",
    noun: "binding",
    present: "Connecting",
    presentLabel: "Connecting binding",
    icon: LinkSimple,
    runningNeedsOutput: false,
  },
  setGadgetBinding: {
    summary: "Wired up",
    past: "Wired up",
    noun: "binding",
    present: "Wiring up",
    presentLabel: "Wiring up binding",
    icon: LinkSimple,
    runningNeedsOutput: true,
  },
  // Obsolete predecessor of `setGadgetBinding`; appears only in old chat logs.
  saveCapsuleAsBinding: {
    summary: "Saved resource",
    past: "Saved",
    noun: "resource",
    present: "Saving",
    presentLabel: "Saving resource",
    icon: LinkSimple,
    runningNeedsOutput: false,
  },
  createGadget: {
    summary: "Created gadget",
    past: "Created",
    noun: "gadget",
    present: "Creating",
    presentPhrase: "Creating gadget",
    presentLabel: "Creating gadget",
    icon: Plus,
    runningNeedsOutput: true,
  },
  createWorktree: {
    summary: "Created worktree",
    past: "Created",
    noun: "worktree",
    present: "Creating",
    presentPhrase: "Creating worktree",
    presentLabel: "Creating worktree",
    icon: GitBranch,
    runningNeedsOutput: true,
  },
  executeCode: {
    summary: "Ran code",
    past: "Ran code",
    countLabel: (count) =>
      count === 1 ? "Ran code" : `Ran code ${formatTimes(count)}`,
    present: "Running",
    presentPhrase: "Running code",
    presentLabel: "Running code",
    presentCountLabel: (count) => `Running code ${formatTimes(count)}`,
    icon: Terminal,
    runningNeedsOutput: true,
  },
  giveUp: {
    summary: "Stopped",
    past: "Stopped",
    countLabel: (count) => (count === 1 ? "Stopped" : `Stopped ${count} times`),
    present: "Stopping",
    presentLabel: "Stopping",
    icon: Question,
    runningNeedsOutput: false,
  },
  webFetch: {
    summary: "Fetched",
    past: "Fetched",
    noun: "page",
    present: "Fetching",
    presentLabel: "Fetching web page",
    icon: Globe,
    runningNeedsOutput: true,
  },
  observeUserChanges: {
    summary: "Observed user changes",
    past: "Observed",
    noun: "change set",
    present: "Observing",
    presentPhrase: "Observing user changes",
    presentLabel: "Observing user changes",
    icon: MagnifyingGlass,
    runningNeedsOutput: false,
  },
  listBlueprints: {
    summary: "Listed blueprints",
    past: "Listed blueprints",
    present: "Listing",
    presentPhrase: "Listing blueprints",
    icon: Blueprint,
    runningNeedsOutput: true,
  },
  listConnectableResources: {
    summary: "Listed connectable resources",
    past: "Listed connectable resources",
    present: "Listing",
    presentPhrase: "Listing connectable resources",
    icon: Question,
    runningNeedsOutput: true,
  },
  requestConnection: {
    summary: "Requested connection",
    past: "Requested",
    countLabel: (count) =>
      count === 1 ? "Requested a connection" : `Requested ${count} connections`,
    present: "Requesting",
    presentPhrase: "Requesting a connection",
    icon: Question,
    runningNeedsOutput: true,
  },
  createExternalResource: {
    summary: "Created",
    past: "Created",
    noun: "external resource",
    present: "Creating",
    presentPhrase: "Creating external resource",
    icon: Question,
    runningNeedsOutput: true,
  },
  activateSkill: {
    summary: "Activated skill",
    past: "Activated",
    noun: "skill",
    present: "Activating",
    presentPhrase: "Activating a skill",
    icon: Lightning,
    runningNeedsOutput: true,
  },
  delegateToBot: {
    summary: "Delegated to bot",
    past: "Delegated",
    noun: "subtask",
    countLabel: (count) =>
      count === 1 ? "Delegated to a bot" : `Delegated ${count} subtasks`,
    present: "Delegating",
    presentPhrase: "Delegating to a bot",
    icon: Robot,
    runningNeedsOutput: true,
  },
  messageBot: {
    summary: "Sent direct message",
    past: "Sent",
    noun: "direct message",
    present: "Sending",
    presentPhrase: "Sending a direct message",
    icon: Robot,
    runningNeedsOutput: true,
  },
};

/** The `{verb, target}` summary a tool-call row shows for one call. */
export function getToolCallSummary(
  tc: AiToolCall,
  outputOf?: ToolOutputResolver,
): { verb: string; target?: string } {
  // createGadget names what it produced from the gadget's own stamped output ("Created Doc").
  const verb = tc.toolName === "createGadget"
    ? `Created ${outputOf?.(tc)?.noun ?? "gadget"}`
    : TOOL_META[tc.toolName].summary;
  return { verb, target: toolCallTarget(tc) };
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
  const meta = TOOL_META[toolName];
  return meta.countLabel?.(count)
    ?? (meta.noun ? `${meta.past} ${pluralize(count, meta.noun)}` : meta.past);
}

// `output` names a format when the call is known to be producing one, so the row can use its icon.
/** The icon a tool-call row draws for the call. */
export function getToolIcon(
  toolName: AiToolCall["toolName"] | null | undefined,
  output?: BlueprintOutput,
): PhosphorIcon {
  if (output) return FORMAT_ICONS[output.icon];
  return (toolName && TOOL_META[toolName].icon) || Question;
}

// Present-tense verb for an in-progress tool call.
function getProvisionalToolVerb(toolName: AiToolCall["toolName"]): string {
  return TOOL_META[toolName].presentPhrase ?? TOOL_META[toolName].present;
}

function getProvisionalToolLabel(toolName: AiToolCall["toolName"] | null | undefined) {
  return (toolName && TOOL_META[toolName].presentLabel) || "Using tool";
}

// Present-tense, count-aware label mirroring describeToolCallCount (e.g. "Writing 5 files").
function describeProvisionalToolCount(toolName: AiToolCall["toolName"], count: number): string {
  if (count <= 1) return getProvisionalToolLabel(toolName);
  const meta = TOOL_META[toolName];
  return meta.presentCountLabel?.(count)
    ?? (meta.noun
      ? `${meta.present} ${pluralize(count, meta.noun)}`
      : (meta.presentPhrase ?? meta.present));
}


/**
 * Whether a tool call is still waiting for its result. Only a tool that records an `output` can
 * be seen running: those read as running until their output lands, while the rest are recorded
 * only once finished (or failed, which ends them too).
 */
export function isToolCallRunning(tc: AiToolCall): boolean {
  if (tc.error) return false;
  // `output` exists only on the variants whose tool records one, so reach it via `in` rather
  // than narrowing the whole union by hand (the table already says which tools those are).
  return TOOL_META[tc.toolName].runningNeedsOutput
    && !("output" in tc && tc.output !== undefined);
}

// Where a call's summary points: each tool names its target from a different input field, so
// one call into this switch replaces the seven that each re-derived their own labels.
function toolCallTarget(tc: AiToolCall): string | undefined {
  switch (tc.toolName) {
    case "readFile":
    case "writeFile":
    case "editFile":
      return tc.input.filename;
    case "grep":
      return tc.input.path ?? tc.input.workpiece;
    case "describeBinding":
      return tc.input.gadget === undefined
        ? `${String(tc.input.name)} binding`
        : `${String(tc.input.name)} binding of ${tc.input.gadget}`;
    case "setBindingHook":
      return tc.input.entrypoint
        ? `${tc.input.bindingName} → ${tc.input.entrypoint}`
        : tc.input.bindingName;
    case "setGadgetBinding":
      return formatGadgetBindingTarget(tc.input.gadget, tc.input.name ?? tc.input.source);
    case "saveCapsuleAsBinding":
      return tc.input.bindingName;
    case "createGadget":
      return tc.input.title;
    case "createWorktree":
      return tc.input.title;
    case "executeCode": {
      // Prefer the first non-empty line as a preview. `code` may be absent while the tool call's
      // input is still streaming in, so guard against undefined.
      const firstLine = tc.input.code
        ?.split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      return firstLine
        ? firstLine.length > 60
          ? `${firstLine.slice(0, 57)}…`
          : firstLine
        : undefined;
    }
    case "giveUp":
      return undefined;
    case "webFetch": {
      let target = tc.input.url;
      try {
        target = new URL(tc.input.url).host;
      } catch {
        // Leave as the raw URL.
      }
      return target;
    }
    case "observeUserChanges":
      return undefined;
    case "listBlueprints":
      return undefined;
    case "listConnectableResources":
      return tc.input.vendorId;
    case "requestConnection":
      return tc.input.vendorId;
    case "createExternalResource":
      return tc.input.title;
    case "activateSkill":
      return tc.input.skill;
    case "delegateToBot":
      return tc.input.bot;
    case "messageBot":
      return tc.input.to;
  }
  // Compile-time exhaustiveness check.
  const _exhaustive: never = tc;
  return (_exhaustive as { toolName: string }).toolName;
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
 * (one row per run; see buildChatDisplayEntries), or null when the run produced nothing.
 */
export function buildToolCallGroup(
  toolCalls: AiToolCall[],
  observations: ObservationChatMessage[] = [],
  outputOf?: ToolOutputResolver,
): ToolCallGroup | null {
  if (toolCalls.length === 0 && observations.length === 0) return null;

  const distinctToolNames = Array.from(new Set(toolCalls.map((tc) => tc.toolName)));
  const targets = toolCalls
    .map((tc) => toolCallTarget(tc))
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

  return {
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
  };
}
