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

const REMARK_PLUGINS_NO_CAPSULES = [remarkGfm];
const MARKDOWN_COMPONENTS_NO_CAPSULES = getMarkdownComponents();

/**
 * A message's markdown, with recorded capsule/format mentions substituted back in. Exported for
 * unit testing (see ChatInterface.markdown.test.tsx), which verifies that a single newline in a
 * user message survives to the DOM as a literal "\n" so the `whitespace-pre-wrap` wrapper at the
 * user-message render site renders it as a hard break.
 */
export const MarkdownMessage = memo(function MarkdownMessage(
  { message, capsules, formats }: {
    message: string;
    capsules?: CapsuleSpecifier[];
    formats?: MessageFormatRef[];
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
    () => tokenizedMessage
      ? [remarkGfm, createCapsuleRemarkPlugin(tokenizedMessage.mentionsByToken)]
      : REMARK_PLUGINS_NO_CAPSULES,
    [tokenizedMessage],
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
