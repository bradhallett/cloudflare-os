import { Fragment, type ReactNode } from "react";

/**
 * Splices inline nodes into plain text at recorded positions, so a slash command and a format each
 * only have to know where they sit.
 *
 * The plain-text counterpart to the markdown path's token substitution (see
 * buildTokenizedCapsuleMessage): markdown needs tokens because it reflows the text it is given,
 * while text rendered as typed can be cut at the offsets directly.
 */
export function TextWithMentions(
  { text, mentions }: {
    text: string;
    /** `length` 0 inserts between characters, for something that was removed from the text. */
    mentions: { key: string; position: number; length: number; node: ReactNode }[];
  },
) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const mention of [...mentions].toSorted((a, b) => a.position - b.position)) {
    // Anything that would rewind the cursor is skipped: overlapping spans have no meaning, and
    // stored messages predate the validation that now refuses them.
    if (mention.position < cursor || mention.position > text.length) continue;
    if (mention.position > cursor) parts.push(text.slice(cursor, mention.position));
    parts.push(<Fragment key={mention.key}>{mention.node}</Fragment>);
    cursor = mention.position + mention.length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}
