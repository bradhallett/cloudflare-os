import type { CapsuleSpecifier, MessageFormatRef } from "@gadgets/workshop-shared/api";

const CAPSULE_LINK_PREFIX = "/__gadgets_capsule__/";
const CAPSULE_TOKEN_PREFIX = "GADGETS_CAPSULE_";
const CAPSULE_TOKEN_SUFFIX = "_TOKEN";

type MarkdownAstNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownAstNode[];
};

type TokenizedCapsuleMessage = {
  markdown: string;
  mentionsByToken: Map<string, Mention>;
};

function generateCapsuleToken(
  message: string,
  index: number,
  usedTokens: Set<string>,
) {
  let attempt = 0;
  while (true) {
    const suffix = attempt === 0 ? "" : `_${attempt}`;
    const token = `${CAPSULE_TOKEN_PREFIX}${index}${suffix}${CAPSULE_TOKEN_SUFFIX}`;
    if (!message.includes(token) && !usedTokens.has(token)) {
      return token;
    }
    attempt++;
  }
}

/**
 * A span of a message that renders as an object rather than as text. Capsules and formats share
 * one pipeline; they differ only in what they draw and whether they carry authority.
 */
export type Mention =
  | { kind: "capsule"; capsule: CapsuleSpecifier }
  | { kind: "format"; format: MessageFormatRef };

function mentionText(mention: Mention): string {
  return mention.kind === "capsule"
      ? mention.capsule.description.title
      : mention.format.noun;
}

/**
 * Replaces each recorded capsule/format span of a message with an opaque token, returning the
 * tokenized markdown and the token → mention map the markdown pipeline substitutes back in.
 */
export function buildTokenizedCapsuleMessage(
  message: string,
  capsules: CapsuleSpecifier[] | undefined,
  formats: MessageFormatRef[] | undefined,
): TokenizedCapsuleMessage {
  const spans = [
    ...(capsules ?? []).map(capsule =>
        ({position: capsule.position, length: capsule.length,
          mention: {kind: "capsule", capsule} as Mention})),
    ...(formats ?? []).map(format =>
        ({position: format.position, length: format.length,
          mention: {kind: "format", format} as Mention})),
  ].toSorted((a, b) => a.position - b.position);

  const usedTokens = new Set<string>();
  const mentionsByToken = new Map<string, Mention>();
  let markdown = "";
  let pos = 0;

  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    // Spans are validated non-overlapping server-side, but a stored message predates that check and
    // is replayed verbatim, so skip anything that would rewind the cursor.
    if (span.position < pos) continue;
    const token = generateCapsuleToken(message, i, usedTokens);
    usedTokens.add(token);
    mentionsByToken.set(token, span.mention);
    markdown += message.slice(pos, span.position);
    markdown += token;
    pos = span.position + span.length;
  }

  markdown += message.slice(pos);
  return { markdown, mentionsByToken };
}

function splitTextOnCapsuleTokens(
  value: string,
  mentionsByToken: Map<string, Mention>,
): MarkdownAstNode[] | null {
  const tokens = [...mentionsByToken.keys()];
  const parts: MarkdownAstNode[] = [];
  let cursor = 0;
  let foundToken = false;

  while (cursor < value.length) {
    let nextIndex = -1;
    let nextToken: string | null = null;

    for (const token of tokens) {
      const index = value.indexOf(token, cursor);
      if (index !== -1 && (nextIndex === -1 || index < nextIndex)) {
        nextIndex = index;
        nextToken = token;
      }
    }

    if (nextToken === null) {
      break;
    }

    foundToken = true;
    if (nextIndex > cursor) {
      parts.push({
        type: "text",
        value: value.slice(cursor, nextIndex),
      });
    }

    parts.push({
      type: "link",
      url: `${CAPSULE_LINK_PREFIX}${encodeURIComponent(nextToken)}`,
      children: [
        {
          type: "text",
          value: (() => {
            const mention = mentionsByToken.get(nextToken);
            return mention ? mentionText(mention) : nextToken;
          })(),
        },
      ],
    });

    cursor = nextIndex + nextToken.length;
  }

  if (!foundToken) {
    return null;
  }

  if (cursor < value.length) {
    parts.push({
      type: "text",
      value: value.slice(cursor),
    });
  }

  return parts;
}

function replaceCapsuleTokensInTree(
  node: MarkdownAstNode,
  mentionsByToken: Map<string, Mention>,
) {
  if (!node.children || node.children.length === 0) {
    return;
  }

  const nextChildren: MarkdownAstNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      const replacementNodes = splitTextOnCapsuleTokens(
        child.value,
        mentionsByToken,
      );
      if (replacementNodes) {
        nextChildren.push(...replacementNodes);
        continue;
      }
    }

    if (child.type !== "code" && child.type !== "inlineCode") {
      replaceCapsuleTokensInTree(child, mentionsByToken);
    }
    nextChildren.push(child);
  }

  node.children = nextChildren;
}

/**
 * A remark plugin that substitutes capsule tokens back into links throughout the markdown AST,
 * so a mention survives wherever the message's text reflows to.
 */
export function createCapsuleRemarkPlugin(mentionsByToken: Map<string, Mention>) {
  return function capsuleRemarkPlugin() {
    return (tree: MarkdownAstNode) => {
      replaceCapsuleTokensInTree(tree, mentionsByToken);
    };
  };
}
