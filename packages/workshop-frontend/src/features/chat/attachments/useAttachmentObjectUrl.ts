import { useEffect, useState } from "react";

/** Build a temporary object URL for inlined attachment bytes, revoking it when no longer needed. */
export function useAttachmentObjectUrl(
  content: Uint8Array | undefined,
  mimeType: string,
): string | null {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!content) {
      setObjectUrl(null);
      return;
    }

    const url = URL.createObjectURL(
      new Blob([content as BlobPart], {type: mimeType || "application/octet-stream"}));
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [content, mimeType]);
  return objectUrl;
}
