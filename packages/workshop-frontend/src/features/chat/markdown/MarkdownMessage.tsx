import {
  isValidElement,
  memo,
  useMemo,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import type { CapsuleSpecifier, MessageFormatRef } from "@gadgets/workshop-shared/api";
import { Clipboard as ClipboardIcon } from "@phosphor-icons/react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAuthenticatedApi } from "../../../AuthContext";
import { useVendorBranding } from "../../../useVendorBranding";
import { safeExternalUrl } from "../../../utils/safeExternalUrl";
import { copyToClipboard } from "../../../clipboard";
import styles from "../../../ChatInterface.module.css";
import {
  buildTokenizedCapsuleMessage,
  createCapsuleRemarkPlugin,
  type MarkdownAstNode,
  type Mention,
} from "./capsuleTokenization";
import { FormatMention } from "./FormatMention";

function CapsuleMention({ capsule }: { capsule: CapsuleSpecifier }) {
  const { authenticatedApi } = useAuthenticatedApi();
  const vendorBranding = useVendorBranding(authenticatedApi);
  const logo = capsule.vendorId ? vendorBranding.get(capsule.vendorId)?.logoUrl : undefined;
  const safeUrl = safeExternalUrl(capsule.description.url);
  const body = (
    <>
      {logo && <img src={logo} alt="" className={styles.capsuleMentionLogo} />}
      {capsule.description.title}
    </>
  );
  return safeUrl ? (
    <a
      href={safeUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={styles.capsuleMention}
    >
      {body}
    </a>
  ) : (
    <span className={styles.capsuleMention}>{body}</span>
  );
}

function CodeBlock({ children, ...props }: ComponentPropsWithoutRef<"pre">) {
  const code = isValidElement<{ children?: ReactNode }>(children) &&
      typeof children.props.children === "string"
    ? children.props.children.replace(/\n$/, "")
    : "";

  return (
    <div className={styles.codeBlock}>
      <pre {...props}>{children}</pre>
      <button
        type="button"
        className={styles.codeCopyButton}
        onClick={() => void copyToClipboard(code)}
        aria-label="Copy code"
        title="Copy code"
      >
        <ClipboardIcon size={16} />
      </button>
    </div>
  );
}

function getMarkdownComponents(
  mentionsByToken?: Map<string, Mention>,
): Components {
  return {
    pre: ({ node: _node, ...props }) => <CodeBlock {...props} />,
    table: ({ node: _node, children, ...props }) => (
      <div className={styles.markdownTableWrapper}>
        <table {...props}>{children}</table>
      </div>
    ),
    a: ({ node: _node, href, children, ...props }) => {
      if (href?.startsWith("/__gadgets_capsule__/") && mentionsByToken) {
        const token = decodeURIComponent(href.slice("/__gadgets_capsule__/".length));
        const mention = mentionsByToken.get(token);
        if (mention) {
          return mention.kind === "capsule"
              ? <CapsuleMention capsule={mention.capsule} />
              : <FormatMention format={mention.format} />;
        }
      }

      const safeHref = safeExternalUrl(href);
      if (!safeHref) {
        return <>{children}</>;
      }

      return (
        <a
          {...props}
          href={safeHref}
          target="_blank"
          rel="noopener noreferrer"
        >
          {children}
        </a>
      );
    },
  };
}
function replaceNewlinesWithBreaks(node: MarkdownAstNode) {
  if (!node.children) return;
  node.children = node.children.flatMap((child): MarkdownAstNode[] => {
    if (child.type === "text" && child.value?.includes("\n")) {
      return child.value.split(/\r?\n/).flatMap((line, index): MarkdownAstNode[] => [
        ...(index > 0 ? [{ type: "break" }] : []),
        ...(line ? [{ type: "text", value: line }] : []),
      ]);
    }
    replaceNewlinesWithBreaks(child);
    return [child];
  });
}

// Renders a user's single newline as a hard break. Done in the tree rather than with
// `white-space: pre-wrap`, which also shows the newlines Markdown puts between block elements,
// adding a blank line between every list item.
function lineBreaksRemarkPlugin() {
  return replaceNewlinesWithBreaks;
}

const MARKDOWN_COMPONENTS_NO_CAPSULES = getMarkdownComponents();

/**
 * A message's markdown, with recorded capsule/format mentions substituted back in. Exported for
 * unit testing (see ChatInterface.markdown.test.ts). `preserveLineBreaks` renders
 * single newlines as hard breaks, for text people typed rather than Markdown a model wrote.
 */
export const MarkdownMessage = memo(function MarkdownMessage(
  { message, capsules, formats, preserveLineBreaks }: {
    message: string;
    capsules?: CapsuleSpecifier[];
    formats?: MessageFormatRef[];
    preserveLineBreaks?: boolean;
  },
): ReactNode {
  const tokenizedMessage = useMemo(
    () => capsules?.length || formats?.length
      ? buildTokenizedCapsuleMessage(message, capsules, formats)
      : null,
    [capsules, formats, message],
  );
  const components = useMemo(
    () => tokenizedMessage
      ? getMarkdownComponents(tokenizedMessage.mentionsByToken)
      : MARKDOWN_COMPONENTS_NO_CAPSULES,
    [tokenizedMessage],
  );
  const remarkPlugins = useMemo(
    () => [
      remarkGfm,
      ...(tokenizedMessage ? [createCapsuleRemarkPlugin(tokenizedMessage.mentionsByToken)] : []),
      ...(preserveLineBreaks ? [lineBreaksRemarkPlugin] : []),
    ],
    [preserveLineBreaks, tokenizedMessage],
  );

  return (
    <ReactMarkdown
      skipHtml={true}
      remarkPlugins={remarkPlugins}
      components={components}
    >
      {tokenizedMessage?.markdown ?? message}
    </ReactMarkdown>
  );
});
