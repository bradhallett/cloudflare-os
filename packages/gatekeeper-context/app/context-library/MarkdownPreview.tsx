/** Rendered Markdown preview (View mode for .md documents). */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { isImageContentType } from "../../src/context-types";
import { useContextApi } from "../bridge";
import { dataUri, dirName, isExternalImageSrc, resolveCollectionPath, stripFrontmatter } from "./paths";

// Rendered prose for Markdown in View mode (Edit mode drops to the source editor). Frontmatter is
// stripped — its fields already show in the "When to use this" row. Prose styling: `.kb-mdx-content`.
function MarkdownImage({
  collectionId,
  documentPath,
  imageCache,
  src = "",
  alt = "",
}: {
  collectionId: string;
  documentPath: string;
  imageCache: { current: Map<string, string> };
  src?: string;
  alt?: string;
}) {
  const context = useContextApi();
  const [resolvedSrc, setResolvedSrc] = useState(src);

  useEffect(() => {
    setResolvedSrc(src);
    if (!src || isExternalImageSrc(src)) return;

    let cancelled = false;
    const imagePath = resolveCollectionPath(dirName(documentPath), src);
    const cached = imageCache.current.get(imagePath);
    if (cached) {
      setResolvedSrc(cached);
      return;
    }
    context.getContextDocument(collectionId, imagePath)
      .then((doc) => {
        if (!cancelled && doc && isImageContentType(doc.contentType)) {
          const uri = dataUri(doc.contentType, doc.body);
          imageCache.current.set(imagePath, uri);
          setResolvedSrc(uri);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [context, collectionId, documentPath, imageCache, src]);

  return <img src={resolvedSrc} alt={alt} />;
}

export function MarkdownPreview({
  body,
  collectionId,
  documentPath,
}: {
  body: string;
  collectionId: string;
  documentPath: string;
}) {
  const content = useMemo(() => stripFrontmatter(body).trim(), [body]);
  const imageCache = useRef(new Map<string, string>());
  const components = useMemo(
    () => ({
      img({ src, alt }: ComponentProps<"img">) {
        return (
          <MarkdownImage
            collectionId={collectionId}
            documentPath={documentPath}
            imageCache={imageCache}
            src={typeof src === "string" ? src : ""}
            alt={typeof alt === "string" ? alt : ""}
          />
        );
      },
    }),
    [collectionId, documentPath],
  );

  return (
    <div className="ctx-scroll h-full min-w-0 overflow-auto">
      <div className="ctx-fade w-full min-w-0 max-w-full px-6 pb-12 pt-6 sm:max-w-[52rem] sm:px-10">
        <div className="kb-mdx-content min-w-0 max-w-full text-[16px] leading-[1.72] tracking-[-0.15px] text-kumo-default">
          {content ? (
            <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={components}>
              {content}
            </ReactMarkdown>
          ) : (
            <p className="italic text-kumo-inactive">This document is empty.</p>
          )}
        </div>
      </div>
    </div>
  );
}
