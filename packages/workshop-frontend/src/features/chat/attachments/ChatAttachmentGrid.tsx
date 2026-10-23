import { memo, useCallback, useState } from "react";
import type { ChatAttachmentRef } from "@gadgets/workshop-shared/api";
import { AttachmentPreviewModal, type AttachmentDownloadHandler } from "./AttachmentPreviewModal";
import { ChatAttachmentThumbnail } from "./ChatAttachmentThumbnail";

type ChatAttachmentGridProps = {
  attachments: ChatAttachmentRef[];
  onDownload?: AttachmentDownloadHandler;
};

/** The row of thumbnails under a sent message with attachments, plus the preview modal. */
export const ChatAttachmentGrid = memo(function ChatAttachmentGrid(
  {
    attachments,
    onDownload,
  }: ChatAttachmentGridProps,
) {
  const [previewAttachmentId, setPreviewAttachmentId] = useState<string | null>(null);
  const previewAttachment = previewAttachmentId === null
    ? null
    : attachments.find((attachment) => attachment.id === previewAttachmentId) ?? null;
  const handlePreview = useCallback((id: string) => setPreviewAttachmentId(id), []);
  const handleClose = useCallback(() => setPreviewAttachmentId(null), []);

  return (
    <>
      <div className="mb-2 flex flex-wrap gap-2">
        {attachments.map((attachment) => (
          <ChatAttachmentThumbnail
            key={attachment.id}
            attachment={attachment}
            onPreview={handlePreview}
          />
        ))}
      </div>
      <AttachmentPreviewModal
        attachment={previewAttachment}
        onClose={handleClose}
        onDownload={onDownload}
      />
    </>
  );
});
