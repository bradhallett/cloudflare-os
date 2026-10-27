// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AiChatMessage } from "@gadgets/workshop-shared/api";

import type { ChatTranscriptProps } from "./ChatTranscript";
import { ChatTranscript } from "./ChatTranscript";
import type { ChatDisplayEntry } from "./transcript/chatDisplayEntries";
import type { FailedChatSend } from "./transcript/failedSends";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

function transcriptProps(displayEntries: ChatDisplayEntry[]): ChatTranscriptProps {
  return {
    isLoading: false,
    isLoadingEarlier: false,
    pendingConsoleLogCount: 0,
    useConstrainedChatWidth: false,
    displayEntries,
    entryTopClasses: [],
    currentUser: null,
    chatEpoch: 0,
    isAgentActive: false,
    activeAgent: undefined,
    hideOwnUserName: false,
    showThinkingTraces: false,
    restricted: false,
    lastMessageSequence: undefined,
    currentMessages: [] as AiChatMessage[],
    queuedSteers: undefined,
    turnChanges: {
      lastDurablePendingChange: null,
      pendingChangeByTurnItemSeq: new Map(),
      createdWorkpiecesByTurnItemSeq: new Map(),
      completedAgentTurnMessageSeqs: new Set<number>(),
      latestCompletedAgentTurnMessageSeq: null,
      handleRevertChanges: async () => {},
    },
    expansion: {
      toolCalls: { keys: new Set<string>(), toggle: () => {}, reset: () => {} },
      actions: { keys: new Set<number>(), toggle: () => {}, reset: () => {} },
      errors: { keys: new Set<string>(), toggle: () => {}, reset: () => {} },
      compactions: { keys: new Set<number>(), toggle: () => {}, reset: () => {} },
    },
    tools: {
      resolveToolOutput: (() => undefined) as never,
      onOpenGadget: () => {},
      getOverseer: () => ({}) as never,
    },
    actionCards: {
      processingActions: new Set<number>(),
      resolveAction: (() => {}) as never,
      setAutoApproveConfirm: () => {},
      isTagAutoApproved: () => false,
      handleToggleHook: async () => {},
    },
    connections: {
      processingConnections: new Set<string>(),
      handleAcceptConnection: (() => {}) as never,
      handleDenyConnection: async () => {},
    },
    errorHandling: {
      setUsageModalOpen: () => {},
      handleRetry: async () => {},
      retryModelId: null,
    },
    messages: {
      messageStates: { changeStatus: new Map(), mergeTimestamps: new Map(), revertTimestamps: new Map() },
      handleCopyMessage: async () => {},
      downloadChatAttachment: async () => {},
    },
    currentRowBuffer: null,
    currentHasUserDraftRows: false,
    handleDiscardDraftChanges: async () => {},
    handleFinalizeDraftChanges: async () => {},
    currentProvisionalState: null,
    provisionalToolCalls: [],
    isCompacting: false,
    onRetryFailedSend: vi.fn<(send: FailedChatSend) => void>(),
    onDismissFailedSend: vi.fn<(send: FailedChatSend) => void>(),
  };
}

function render(props: ChatTranscriptProps) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<ChatTranscript {...props} />));
}

describe("ChatTranscript", () => {
  it("shows the empty state when a chat has no messages yet", () => {
    render(transcriptProps([]));

    expect(container!.textContent).toContain("Start the conversation");
    expect(container!.textContent).toContain("Send a message below");
  });

  it("shows no empty state while loading, or while the agent is working", () => {
    render({ ...transcriptProps([]), isLoading: true });
    expect(container!.textContent).not.toContain("Start the conversation");
    expect(container!.querySelector(".animate-spin")).not.toBeNull();

    render({ ...transcriptProps([]), isAgentActive: true });
    expect(container!.textContent).not.toContain("Start the conversation");
  });

  it("renders a failed send as a Not sent bubble whose retry re-sends it", () => {
    const send: FailedChatSend = {
      id: "failed-1",
      chatId: 1,
      timestamp: new Date("2026-01-01T12:00:00Z"),
      payload: { message: "never arrived", modelId: null },
    };
    const props = transcriptProps([
      { type: "failedSend", key: "failed-failed-1", send },
    ]);
    render(props);

    expect(container!.textContent).toContain("never arrived");
    expect(container!.textContent).toContain("Not sent");

    act(() => {
      container!.querySelector<HTMLButtonElement>("button:not([aria-label])")!.click();
    });
    expect(props.onRetryFailedSend).toHaveBeenCalledWith(send);

    act(() => {
      container!.querySelector<HTMLButtonElement>('[aria-label="Remove failed message"]')!.click();
    });
    expect(props.onDismissFailedSend).toHaveBeenCalledWith(send);
  });
});
