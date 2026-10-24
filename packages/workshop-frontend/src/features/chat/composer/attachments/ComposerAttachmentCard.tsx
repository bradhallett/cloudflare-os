import {
  ArrowClockwiseIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileDocIcon,
  FileIcon,
  FilePdfIcon,
  FilePptIcon,
  FileTextIcon,
  FileVideoIcon,
  FileXlsIcon,
  FileZipIcon,
  WarningIcon,
  XIcon,
  type Icon,
} from "@phosphor-icons/react";
import { Button, SkeletonLine, Tooltip } from "@cloudflare/kumo";
import { useDelayedLoading } from "@gadgets/ui";
import { attachmentKind, type AttachmentKind } from "./attachmentKind";
import { splitFileName } from "./splitFileName";
import type { ComposerAttachment } from "./useComposerAttachments";

// Everything visual about an attachment card lives in this file; the tray only lays cards out.
const KIND_ICONS: Record<AttachmentKind, Icon> = {
  image: FileIcon,
  pdf: FilePdfIcon,
  audio: FileAudioIcon,
  video: FileVideoIcon,
  spreadsheet: FileXlsIcon,
  document: FileDocIcon,
  presentation: FilePptIcon,
  archive: FileZipIcon,
  code: FileCodeIcon,
  text: FileTextIcon,
  file: FileIcon,
};

const CARD_CLASS =
  "group relative h-[90px] w-[90px] shrink-0 overflow-hidden rounded-xl bg-kumo-control hover:bg-kumo-tint sm:h-[110px] sm:w-[110px]";

// A 1px inset outline drawn over the content, so it stays inside the card and above preview images.
const OUTLINE_CLASS =
  "pointer-events-none absolute inset-0 rounded-xl ring-1 ring-inset ring-kumo-line";

// Hidden until hover or focus, but only on devices that can hover: touch has no hover to reveal it
// (and `focus-visible` does not fire on a tap), so there it stays visible. This keys off the input
// capability rather than viewport width, which would also hide it on tablets. `group-hover` is
// already limited to hover-capable devices by Tailwind.
const REMOVE_BUTTON_CLASS =
  "absolute right-1.5 top-1.5 flex h-5 w-5 cursor-pointer items-center justify-center rounded-full bg-kumo-base text-kumo-default shadow-sm ring-1 ring-kumo-line hover:bg-kumo-tint focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:cursor-not-allowed disabled:opacity-50 [@media(hover:hover)]:opacity-0 group-hover:opacity-100";

const NAME_TEXT_CLASS =
  "text-[11px] font-medium leading-[14px] sm:text-[12px] sm:leading-4";

// A long name truncates its base with an ellipsis but never its extension, so `very-long-name.pdf`
// reads as `very-long-na….pdf` (the full name is on the card's tooltip).
const AttachmentFileName = ({ name, muted }: { name: string; muted: boolean }) => {
  const tone = muted ? "text-kumo-subtle" : "text-kumo-default";
  const parts = splitFileName(name);
  if (!parts) {
    return <span className={`break-words line-clamp-2 ${NAME_TEXT_CLASS} ${tone}`}>{name}</span>;
  }
  return (
    <span className={`flex min-w-0 flex-nowrap ${NAME_TEXT_CLASS} ${tone}`}>
      <span className="min-w-0 truncate">{parts.base}</span>
      <span className="shrink-0">{parts.extension}</span>
    </span>
  );
};

export const ComposerAttachmentCard = ({
  attachment,
  disabled,
  onRemove,
  onRetry,
}: {
  attachment: ComposerAttachment;
  disabled: boolean;
  onRemove: () => void;
  onRetry: () => void;
}) => {
  const name = attachment.name ?? "Attached file";
  const KindIcon = KIND_ICONS[attachmentKind(attachment.mimeType, attachment.name)];
  const failed = attachment.uploadState === "error";
  const uploading = attachment.uploadState === "uploading";
  // Uploads that finish quickly never flash a skeleton; one slow enough to show it holds it long
  // enough not to flicker. Until then the card shows its real content.
  const showSkeleton = useDelayedLoading(uploading);

  return (
    <Tooltip content={name} side="top" asChild>
      <div className={CARD_CLASS}>
        {uploading && showSkeleton ? (
          <>
            <SkeletonLine minWidth={100} maxWidth={100} className="h-full w-full" />
            <span className="sr-only">Uploading {name}</span>
          </>
        ) : attachment.previewUrl && !failed ? (
          <img src={attachment.previewUrl} alt={name} className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full flex-col justify-between p-2.5 sm:p-3">
            {failed ? (
              <div className="flex flex-col items-start gap-1">
                <div className="flex items-center gap-1">
                  <WarningIcon size={16} className="text-kumo-danger" />
                  <span className={`${NAME_TEXT_CLASS} text-kumo-danger`}>Upload failed</span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  shape="square"
                  size="xs"
                  icon={ArrowClockwiseIcon}
                  aria-label={`Retry upload of ${name}`}
                  disabled={disabled}
                  onClick={onRetry}
                />
              </div>
            ) : (
              <KindIcon size={20} className="text-kumo-default" />
            )}
            <AttachmentFileName name={name} muted={failed} />
          </div>
        )}
        <span aria-hidden="true" className={OUTLINE_CLASS} />
        <button
          type="button"
          aria-label={`Remove ${name}`}
          disabled={disabled}
          onClick={onRemove}
          className={REMOVE_BUTTON_CLASS}
        >
          <XIcon size={10} weight="bold" />
        </button>
      </div>
    </Tooltip>
  );
};
