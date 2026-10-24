import { memo, useEffect, useRef } from "react";
import type { ChatAttachmentRef } from "@gadgets/workshop-shared/api";
import { File as FileIcon, X } from "@phosphor-icons/react";
import { formatAttachmentSize } from "../attachmentFormatting";
import { matchesHotkey } from "@gadgets/ui/hotkey";
import { useAttachmentObjectUrl } from "./useAttachmentObjectUrl";

/** Downloads an attachment by its handle. */
export type AttachmentDownloadHandler = (attachment: ChatAttachmentRef) => void;

type AttachmentPreviewModalProps = {
  attachment: ChatAttachmentRef | null;
  onClose: () => void;
  onDownload?: AttachmentDownloadHandler;
};

/** Full-screen preview of a chat attachment, with keyboard handling and focus restoration. */
export const AttachmentPreviewModal = memo(function AttachmentPreviewModal(
  {
    attachment,
    onClose,
    onDownload,
  }: AttachmentPreviewModalProps,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isImage = (attachment?.mimeType ?? "").startsWith("image/");
  const objectUrl = useAttachmentObjectUrl(
    isImage ? attachment?.content : undefined, attachment?.mimeType ?? "");

  // Dialog keyboard handling: Escape closes, Tab stays trapped, focus restores on close.
  useEffect(() => {
    if (!attachment) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (matchesHotkey(event, "escape")) {
        onClose();
        return;
      }
      if (event.key === "Tab" && containerRef.current) {
        const focusable = containerRef.current.querySelectorAll<HTMLElement>(
          'button, [href], iframe, [tabindex]:not([tabindex="-1"])');
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    // Defer to after paint so the close button exists.
    const raf = requestAnimationFrame(() => {
      containerRef.current?.querySelector<HTMLElement>("button")?.focus();
    });
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      cancelAnimationFrame(raf);
      previouslyFocused?.focus?.();
    };
  }, [attachment, onClose]);

  if (!attachment) return null;

  const sizeLabel = formatAttachmentSize(attachment.size);
  const title = attachment.name ?? "Attached file";
  const modalWidthClass = isImage
    ? "w-[min(1120px,calc(100vw-32px))]"
    : "w-[min(520px,calc(100vw-32px))]";
  const modalSurfaceClass = "rounded-2xl border border-kumo-line/70 bg-kumo-base";
  const modalPaddingClass = "p-3 sm:p-4";

  return (
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-label={`Preview ${title}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={containerRef} className={`relative max-h-[calc(var(--app-height)-32px)] ${modalWidthClass} overflow-hidden ${modalSurfaceClass} p-0 shadow-[0_24px_80px_rgba(0,0,0,0.28)]`}>
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 z-10 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border border-kumo-line bg-kumo-base/90 text-kumo-subtle shadow-[0_1px_2px_rgba(0,0,0,0.05)] backdrop-blur-sm transition-[background-color,color,transform] duration-150 ease-out hover:bg-kumo-base hover:text-kumo-default active:scale-[0.96]"
          aria-label="Close preview"
        >
          <X size={18} />
        </button>

        <div className={modalPaddingClass}>
          {isImage && objectUrl ? (
            <img
              src={objectUrl}
              alt={title}
              className="max-h-[calc(var(--app-height)-96px)] w-full rounded-xl object-contain"
            />
          ) : (
            <div className="grid min-h-56 place-items-center rounded-xl border border-kumo-line/70 bg-kumo-elevated/40 p-6 py-10 text-center">
              <div className="max-w-sm space-y-2">
                <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-kumo-line/70 bg-kumo-base text-kumo-inactive">
                  <FileIcon size={26} />
                </div>
                <div className="text-[14px] font-medium text-kumo-default">{title}</div>
                <div className="text-[12px] leading-5 text-kumo-subtle">
                  {attachment.mimeType || "Unknown file type"}{sizeLabel ? ` · ${sizeLabel}` : ""}
                </div>
                <div className="text-[12px] leading-5 text-kumo-inactive">This file can’t be previewed here.</div>
                {onDownload && (
                  <button
                    type="button"
                    onClick={() => onDownload(attachment)}
                    className="mt-1 inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-kumo-line/70 bg-kumo-base px-3 py-1.5 text-[12px] font-medium text-kumo-default transition-colors hover:bg-kumo-tint/40"
                  >
                    Download
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
