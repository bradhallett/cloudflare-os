// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerAttachmentTray } from "./ComposerAttachmentTray";
import type { ComposerAttachment } from "./useComposerAttachments";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const attachment = (overrides: Partial<ComposerAttachment>): ComposerAttachment => ({
  id: "a",
  blob: new Blob([]),
  mimeType: "application/pdf",
  name: "report.pdf",
  uploadState: "ready",
  ...overrides,
});

let root: Root | undefined;
let container: HTMLElement | undefined;

const render = (
  attachments: ComposerAttachment[],
  {
    disabled = false,
    onRemove = () => {},
    onRetry = () => {},
  }: { disabled?: boolean; onRemove?: (id: string) => void; onRetry?: (id: string) => void } = {},
) => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <ComposerAttachmentTray
        attachments={attachments}
        disabled={disabled}
        onRemove={onRemove}
        onRetry={onRetry}
      />,
    );
  });
  return container;
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.useRealTimers();
});

describe("ComposerAttachmentTray", () => {
  it("shows no cards without attachments", () => {
    expect(render([]).querySelectorAll("li")).toHaveLength(0);
  });

  it("removes the attachment whose button was pressed, naming it for assistive tech", () => {
    const onRemove = vi.fn<(id: string) => void>();
    const view = render(
      [attachment({ id: "one", name: "one.pdf" }), attachment({ id: "two", name: "two.pdf" })],
      { onRemove },
    );

    const button = view.querySelector<HTMLButtonElement>('button[aria-label="Remove two.pdf"]')!;
    act(() => button.click());

    expect(onRemove).toHaveBeenCalledExactlyOnceWith("two");
  });

  it("blocks removal while disabled", () => {
    const onRemove = vi.fn<(id: string) => void>();
    const view = render([attachment({})], { disabled: true, onRemove });

    const button = view.querySelector<HTMLButtonElement>("button")!;

    expect(button.disabled).toBe(true);
    act(() => button.click());
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("shows an image as a preview and any other file as an icon card with its name", () => {
    const view = render([
      attachment({ id: "img", name: "photo.png", mimeType: "image/png", previewUrl: "blob:photo" }),
      attachment({ id: "doc", name: "report.pdf" }),
    ]);

    const image = view.querySelector("img")!;
    expect(image.getAttribute("src")).toBe("blob:photo");
    expect(view.querySelectorAll("img")).toHaveLength(1);
    expect(view.textContent).toContain("report.pdf");
    expect(view.textContent).not.toContain("photo.png");
  });

  it("shows a card's real content while an upload is fast, then hides it once the upload is slow", () => {
    vi.useFakeTimers();
    const view = render([
      attachment({ name: "photo.png", mimeType: "image/png", previewUrl: "blob:photo", uploadState: "uploading" }),
    ]);

    // Fast uploads never flash a skeleton: within the delay the preview is simply there.
    expect(view.querySelector("img")!.getAttribute("src")).toBe("blob:photo");
    expect(view.querySelector(".sr-only")).toBeNull();

    // A slow upload replaces the content with a skeleton that still announces the upload.
    act(() => vi.advanceTimersByTime(150));
    expect(view.querySelector("img")).toBeNull();
    expect(view.querySelector(".sr-only")?.textContent).toBe("Uploading photo.png");
  });

  it("reports a failed upload next to the file name, replacing any image preview", () => {
    const view = render([
      attachment({ name: "photo.png", mimeType: "image/png", previewUrl: "blob:photo", uploadState: "error" }),
    ]);

    expect(view.querySelector("img")).toBeNull();
    expect(view.textContent).toContain("Upload failed");
    expect(view.textContent).toContain("photo.png");
  });

  it("offers retry on a failed upload only, naming the file for assistive tech", () => {
    const onRetry = vi.fn<(id: string) => void>();
    const view = render(
      [attachment({ id: "one", name: "one.pdf", uploadState: "error" })],
      { onRetry },
    );

    const retry = view.querySelector<HTMLButtonElement>('button[aria-label="Retry upload of one.pdf"]')!;
    act(() => retry.click());

    expect(onRetry).toHaveBeenCalledExactlyOnceWith("one");

    const ready = render([attachment({ id: "two", name: "two.pdf", uploadState: "ready" })]);
    expect(ready.querySelector('button[aria-label^="Retry upload of"]')).toBeNull();
  });

  it("blocks retry while disabled", () => {
    const onRetry = vi.fn<(id: string) => void>();
    const view = render([attachment({ uploadState: "error" })], { disabled: true, onRetry });

    const retry = view.querySelector<HTMLButtonElement>('button[aria-label="Retry upload of report.pdf"]')!;

    expect(retry.disabled).toBe(true);
    act(() => retry.click());
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("renders a long name as a truncatable base plus an untruncated extension", () => {
    const view = render([attachment({ id: "long", name: "a-very-long-file-name.pdf" })]);

    const base = view.querySelector("span.truncate")!;
    const extension = view.querySelector("span.shrink-0")!;
    expect(base.textContent).toBe("a-very-long-file-name");
    expect(extension.textContent).toBe(".pdf");

    // A name with no extension worth keeping renders as one clamped span instead.
    const plain = render([attachment({ id: "none", name: "Makefile" })]);
    expect(plain.querySelector("span.truncate")).toBeNull();
    expect(plain.querySelector("span.shrink-0")).toBeNull();
    expect(plain.textContent).toContain("Makefile");
  });
});
