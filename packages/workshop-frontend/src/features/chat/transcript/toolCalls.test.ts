import { describe, expect, it } from "vitest";
import type { AiToolCall } from "@gadgets/workshop-shared/api";
import type { ProvisionalToolCallState } from "../provisionalChatState";
import { buildProvisionalToolSummary, buildToolCallGroups, isToolCallRunning } from "./toolCalls";

// An executeCode call, overridable with the fields the running state keys off.
const codeCall = (
  overrides: { toolCallId?: string; output?: string; error?: string } = {},
): AiToolCall => ({
  toolCallId: "call-1",
  toolName: "executeCode",
  input: { code: "console.log(1)" },
  ...overrides,
});

const provisionalCall = (
  overrides: Partial<ProvisionalToolCallState> = {},
): ProvisionalToolCallState => ({
  toolCallId: "call-1",
  toolName: "executeCode",
  code: "",
  output: "",
  finished: false,
  ...overrides,
});

describe("isToolCallRunning", () => {
  it("runs until output arrives, then stops", () => {
    expect(isToolCallRunning(codeCall())).toBe(true);
    expect(isToolCallRunning(codeCall({ output: "done" }))).toBe(false);
    expect(isToolCallRunning(codeCall({ output: "" }))).toBe(false);
  });

  it("never runs a call that failed -- the Error pill speaks for it", () => {
    expect(isToolCallRunning(codeCall({ error: "boom" }))).toBe(false);
  });

  it("counts a tool that records no output as finished either way", () => {
    const writeFile: AiToolCall = {
      toolCallId: "call-2",
      toolName: "writeFile",
      input: { filename: "a.ts", content: "" },
    };
    expect(isToolCallRunning(writeFile)).toBe(false);
  });
});

describe("buildToolCallGroups running", () => {
  it("marks a group running while its only call lacks output, and clears it when output lands", () => {
    expect(buildToolCallGroups([codeCall()])[0].running).toBe(true);
    expect(buildToolCallGroups([codeCall({ output: "done" })])[0].running).toBe(false);
  });

  it("keys off the latest call of the run", () => {
    const earlier = codeCall({ toolCallId: "call-0", output: "done" });
    expect(buildToolCallGroups([earlier, codeCall()])[0].running).toBe(true);
    expect(buildToolCallGroups([earlier, codeCall({ output: "done" })])[0].running).toBe(false);
  });

  it("never shows running and error together", () => {
    const group = buildToolCallGroups([codeCall({ error: "boom" })])[0];
    expect(group.hasError).toBe(true);
    expect(group.running).toBe(false);
  });

  it("never shows running once any call of the run failed, even a later one still running", () => {
    const failed = codeCall({ toolCallId: "call-0", error: "boom" });
    const group = buildToolCallGroups([failed, codeCall({ toolCallId: "call-1" })])[0];
    expect(group.hasError).toBe(true);
    expect(group.running).toBe(false);
  });
});

describe("buildProvisionalToolSummary running", () => {
  it("runs until the latest provisional call finishes", () => {
    expect(buildProvisionalToolSummary([provisionalCall()]).running).toBe(true);
    expect(buildProvisionalToolSummary([provisionalCall({ finished: true })]).running).toBe(false);
    expect(buildProvisionalToolSummary([
      provisionalCall({ toolCallId: "call-0", finished: true }),
      provisionalCall({ toolCallId: "call-1" }),
    ]).running).toBe(true);
    expect(buildProvisionalToolSummary([
      provisionalCall({ toolCallId: "call-0" }),
      provisionalCall({ toolCallId: "call-1", finished: true }),
    ]).running).toBe(false);
  });

  it("tolerates an empty call list", () => {
    expect(buildProvisionalToolSummary([])).toEqual({
      label: "Using tool",
      detailLines: [],
      running: false,
    });
  });
});
