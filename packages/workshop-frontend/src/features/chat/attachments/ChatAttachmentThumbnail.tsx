import { memo, useState } from "react";
import type { ChatAttachmentRef } from "@gadgets/workshop-shared/api";
import { File as FileIcon } from "@phosphor-icons/react";
import { useAttachmentObjectUrl } from "./useAttachmentObjectUrl";

type ChatAttachmentThumbnailProps = {
  attachment: ChatAttachmentRef;
  onPreview: (id: string) => void;
};

/** One attachment's thumbnail in the sent-message grid: the image, or a file chip. */
export const ChatAttachmentThumbnail = memo(function ChatAttachmentThumbnail(
  {
    attachment,
    onPreview,
  }: ChatAttachmentThumbnailProps,
) {
  const isImage = attachment.mimeType.startsWith("image/");
  const objectUrl = useAttachmentObjectUrl(isImage ? attachment.content : undefined, attachment.mimeType);
  const [imageState, setImageState] = useState<"loading" | "loaded" | "error">("loading");

  return (
    <button
      type="button"
      onClick={() => onPreview(attachment.id)}
      className="relative h-28 w-36 shrink-0 cursor-pointer overflow-hidden rounded-xl border border-kumo-line/70 bg-kumo-elevated text-left transition-[border-color,background-color,transform] duration-150 ease-out hover:border-kumo-line hover:bg-kumo-tint/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand/40 active:scale-[0.98]"
      aria-label={`Preview ${attachment.name ?? "attached file"}`}
    >
      {isImage && objectUrl && imageState !== "error" ? (
        <>
          {/* Kept in layout (not display:none) so lazy-loading actually triggers. */}
          <img
            src={objectUrl}
            alt={attachment.name ?? "Attached image"}
            loading="lazy"
            className="block h-full w-full object-cover"
            onLoad={() => setImageState("loaded")}
            onError={() => setImageState("error")}
          />
          {imageState !== "loaded" && (
            <div className="absolute inset-0 grid place-items-center bg-kumo-elevated text-[11px] text-kumo-inactive">Loading image…</div>
          )}
        </>
      ) : (
        <div className="flex h-full w-full min-w-0 items-center justify-center gap-2 p-3 text-[12px] leading-4 text-kumo-subtle">
          <FileIcon size={20} className="shrink-0 text-kumo-inactive" />
          <span className="min-w-0 truncate">{attachment.name ?? "Attached file"}</span>
        </div>
      )}
    </button>
  );
});
