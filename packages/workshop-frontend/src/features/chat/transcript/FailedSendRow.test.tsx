// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FailedSendRow } from "./FailedSendRow";
import type { FailedChatSend } from "./failedSends";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

const render = (send: FailedChatSend) => {
  const onRetry = vi.fn<(send: FailedChatSend) => void>();
  const onDismiss = vi.fn<(send: FailedChatSend) => void>();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(
    <FailedSendRow
      send={send}
      getOverseer={() => ({}) as never}
      onRetry={onRetry}
      onDismiss={onDismiss}
    />,
  ));
  return { onRetry, onDismiss };
};

const send = (payload: FailedChatSend["payload"]): FailedChatSend => ({
  id: "failed-1",
  chatId: 7,
  timestamp: new Date("2026-01-01T12:00:00Z"),
  payload,
});

describe("FailedSendRow", () => {
  it("shows the failed message in a destructive bubble marked Not sent", () => {
    render(send({ message: "please work", modelId: null }));

    expect(container!.textContent).toContain("please work");
    expect(container!.textContent).toContain("Not sent");
    const bubble = container!.firstElementChild!.firstElementChild as HTMLElement;
    expect(bubble.className).toContain("bg-kumo-danger-tint");
    expect(bubble.className).toContain("border-kumo-danger/30");
  });

  it("names the attachments that never made it", () => {
    render(send({
      message: "see attached",
      modelId: null,
      attachments: [{ id: "1", name: "notes.txt" } as never],
    }));

    expect(container!.textContent).toContain("Attached: notes.txt");
  });

  it("retries and dismisses through the exact failed record", () => {
    const failed = send({ message: "again", modelId: "model-a" });
    const { onRetry, onDismiss } = render(failed);

    act(() => {
      container!.querySelector<HTMLButtonElement>("button:not([aria-label])")!.click();
    });
    expect(onRetry).toHaveBeenCalledWith(failed);

    act(() => {
      container!.querySelector<HTMLButtonElement>('[aria-label="Remove failed message"]')!.click();
    });
    expect(onDismiss).toHaveBeenCalledWith(failed);
  });
});
