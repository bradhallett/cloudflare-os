import {describe, expect, it} from "vitest";
import {type AiChatAuthorInfo, type AiChatMessage, type AiChatMessageBody}
  from "@gadgets/workshop-shared/api";
import {ChatBindingScope, applyMessageBindings} from "../src/project-chat-log";

const user: AiChatAuthorInfo = {type: "user", id: "user", name: "User"};

function record(sequence: number, body: AiChatMessageBody): AiChatMessage {
  return {chatId: 1, sequence, timestamp: new Date(sequence), author: user, ...body};
}

function capsuleMessage(sequence: number, name: string | undefined, gatekeeperId: number)
    : AiChatMessage {
  return record(sequence, {
    type: "message", message: "look at [0]",
    capsules: [{position: 8, length: 3, gatekeeperId, bindingName: name,
                description: {title: "A resource", mimeType: "text/plain"}}],
  });
}

function createCall(sequence: number, toolName: "createGadget" | "createWorktree"
    | "createExternalResource", bindingName: string, id: number, error?: string): AiChatMessage {
  let output = toolName === "createGadget" ? {gadgetId: id, changeId: 0}
      : toolName === "createWorktree" ? {worktreeId: id, changeId: 0}
      : {gatekeeperId: id, changeId: 0};
  return record(sequence, {
    type: "message", message: "",
    toolCalls: [{toolCallId: `call-${sequence}`, toolName, input: {bindingName},
                 output: error === undefined ? output : undefined, error}],
  });
}

function connectionRequest(sequence: number, state: "pending" | "accepted" | "denied",
                           bindingName: string | undefined, gatekeeperId?: number): AiChatMessage {
  return record(sequence, {
    type: "connectionRequest", state, bindingName, gatekeeperId,
    vendorName: "Acme", resourceTitle: "Acme API",
  });
}

function changesMessage(sequence: number, gadgets: [number, string][] = [],
                        worktrees: [number, string][] = []): AiChatMessage {
  return record(sequence, {
    type: "changes",
    createdGadgets: gadgets.map(([gadgetId, bindingName]) =>
        ({gadgetId, bindingName, title: bindingName})),
    createdWorktrees: worktrees.map(([worktreeId, bindingName]) =>
        ({worktreeId, bindingName, title: bindingName})),
  });
}

function agentCallbackMessage(sequence: number, bindingName: string | undefined): AiChatMessage {
  return record(sequence, {
    type: "agentCallback", bindingName, methodName: "onEvent", argsSummary: "[]",
  });
}

describe("ChatBindingScope seed", () => {
  it("seeds entries first-wins, taking names and indexing workpiece targets", () => {
    let scope = new ChatBindingScope([
      ["seed", {type: "workpiece", id: 7}],
      ["seed", {type: "workpiece", id: 8}],  // duplicate name: first target wins
      ["other", {type: "workpiece", id: 7}],  // duplicate target: first name indexed
    ]);
    expect(scope.bindings.get("seed")).toEqual({type: "workpiece", id: 7});
    expect(scope.taken).toEqual(new Set(["seed", "other"]));
    expect(scope.nameByTarget.get(7)).toBe("seed");
    expect(scope.nameFor(7)).toBe("seed");
  });
});

describe("applyMessageBindings", () => {
  it("binds capsules first-wins by name", () => {
    let scope = new ChatBindingScope();
    applyMessageBindings(scope, capsuleMessage(1, "notion", 10));
    applyMessageBindings(scope, capsuleMessage(2, "notion", 11));
    expect(scope.bindings.get("notion")).toEqual({type: "workpiece", id: 10});
    expect(scope.inScope("notion")).toBe(true);
  });

  it("takes a failed creation's name but binds nothing; a success rebinds", () => {
    let scope = new ChatBindingScope();
    applyMessageBindings(scope, createCall(1, "createGadget", "calc", 20, "boom"));
    expect(scope.bindings.has("calc")).toBe(false);
    expect(scope.taken.has("calc")).toBe(true);
    expect(scope.inScope("calc")).toBe(false);  // taken names are not resolvable

    applyMessageBindings(scope, createCall(2, "createGadget", "calc", 21));
    expect(scope.bindings.get("calc")).toEqual({type: "workpiece", id: 21});
  });

  it("claims a pending request's name, binds an accepted one first-wins, releases a denied one",
      () => {
    let scope = new ChatBindingScope();
    applyMessageBindings(scope, connectionRequest(1, "pending", "weather"));
    expect(scope.inScope("weather")).toBe(true);
    expect(scope.bindings.has("weather")).toBe(false);

    applyMessageBindings(scope, connectionRequest(2, "accepted", "weather", 30));
    expect(scope.bindings.get("weather")).toEqual({type: "workpiece", id: 30});

    // A second accepted request for another target keeps the first binding.
    applyMessageBindings(scope, connectionRequest(3, "accepted", "weather", 31));
    expect(scope.bindings.get("weather")).toEqual({type: "workpiece", id: 30});

    // A denied request releases its claim: the name is free for a later binding.
    let deniedScope = new ChatBindingScope();
    applyMessageBindings(deniedScope, connectionRequest(1, "denied", "news"));
    expect(deniedScope.inScope("news")).toBe(false);
    expect(deniedScope.taken.has("news")).toBe(false);
    applyMessageBindings(deniedScope, capsuleMessage(2, "news", 40));
    expect(deniedScope.bindings.get("news")).toEqual({type: "workpiece", id: 40});
  });

  it("binds changes-message creations first-wins and agent callbacks as values", () => {
    let scope = new ChatBindingScope();
    applyMessageBindings(scope, changesMessage(1, [[50, "notes"]], [[60, "scratch"]]));
    applyMessageBindings(scope, changesMessage(2, [[51, "notes"]]));
    expect(scope.bindings.get("notes")).toEqual({type: "workpiece", id: 50});
    expect(scope.bindings.get("scratch")).toEqual({type: "workpiece", id: 60});

    applyMessageBindings(scope, agentCallbackMessage(3, "args"));
    expect(scope.bindings.get("args")).toEqual({type: "value", messageSequence: 3});
    applyMessageBindings(scope, agentCallbackMessage(4, undefined));
    expect(scope.bindings.size).toBe(3);
  });

  it("nameFor prefers the first name inserted for a target, including rebinds", () => {
    let scope = new ChatBindingScope();
    applyMessageBindings(scope, capsuleMessage(1, "a", 70));
    applyMessageBindings(scope, createCall(2, "createExternalResource", "b", 70));
    // Two names now reach target 70; the scan reports the earliest.
    expect(scope.nameFor(70)).toBe("a");
    // The naming reverse index is separate: it also holds the first.
    expect(scope.nameByTarget.get(70)).toBe("a");
  });
});
