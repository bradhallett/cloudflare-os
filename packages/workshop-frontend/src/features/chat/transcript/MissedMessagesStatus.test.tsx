// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { MissedMessagesStatus } from "./MissedMessagesStatus";

function renderStatus() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const props = { missedCount: 0, isTurnActive: false };
  const render = async () => {
    await act(async () => {
      root.render(<MissedMessagesStatus {...props} />);
    });
  };
  return {
    status: () => container.querySelector<HTMLElement>('[role="status"]'),
    async set(next: Partial<typeof props>) {
      Object.assign(props, next);
      await render();
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("MissedMessagesStatus", () => {
  it("stays silent while the reader follows the live edge", async () => {
    const status = renderStatus();
    await status.set({ missedCount: 0, isTurnActive: true });
    expect(status.status()!.textContent).toBe("");
    status.unmount();
  });

  it("announces the first missed rows, not every streaming commit, and settles at turn end", async () => {
    const status = renderStatus();
    await status.set({ missedCount: 2, isTurnActive: true });
    expect(status.status()!.textContent).toContain("2 new");

    // Rows keep landing while the turn runs: the growing count is not re-announced.
    await status.set({ missedCount: 5, isTurnActive: true });
    expect(status.status()!.textContent).toContain("2 new");

    // The turn settles: one final announcement carries the settled count.
    await status.set({ missedCount: 5, isTurnActive: false });
    expect(status.status()!.textContent).toContain("5 new");

    status.unmount();
  });

  it("clears and re-arms when the reader returns to the live edge", async () => {
    const status = renderStatus();
    await status.set({ missedCount: 3, isTurnActive: false });
    expect(status.status()!.textContent).toContain("3 new");

    await status.set({ missedCount: 0, isTurnActive: false });
    expect(status.status()!.textContent).toBe("");

    // A later batch of missed rows announces afresh.
    await status.set({ missedCount: 1, isTurnActive: true });
    expect(status.status()!.textContent).toContain("1 new");

    status.unmount();
  });
});
