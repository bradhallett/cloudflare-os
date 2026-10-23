import { MessageFormatRef, isOutputIcon, SlashCommandRequest } from "@gadgets/workshop-shared/api";

// Common internals that several interfaces implemented by the Overseer need to use. Can't just
// declare private methods because some of the methods are needed by multiple classes.
// Most format tokens one message may carry. Only formats picked from the composer menu become
// refs, so this bounds a client-supplied array rather than anything a person can type. Dropping
// the excess costs chips, not text.
const MAX_MESSAGE_FORMAT_REFS = 32;

// Longest noun accepted on a format reference. Denormalized display data.
const MAX_FORMAT_REF_NOUN = 128;

/**
 * Keeps `commandPosition` only if it's a real index into `args`. Anything else becomes undefined,
 * and the command renders at the front. Display-only, so a bad value isn't worth an error.
 */
export function sanitizeCommandPosition(request: SlashCommandRequest): number | undefined {
  let position = request.commandPosition;
  if (position === undefined) return undefined;
  if (!Number.isInteger(position) || position <= 0 || position > request.args.length) {
    return undefined;
  }
  return position;
}

/**
 * Drops format refs the message text doesn't back up. They're display-only and come from the
 * browser, so a bad one costs a chip, not the message. But a chip *replaces* the text it covers,
 * so a ref must cover exactly the noun it names -- or it could hide what the user really wrote.
 */
export function sanitizeMessageFormatRefs(
    refs: MessageFormatRef[] | undefined, message: string | undefined)
    : MessageFormatRef[] | undefined {
  if (!refs?.length || message === undefined) return undefined;

  let accepted: MessageFormatRef[] = [];
  for (let ref of refs) {
    if (accepted.length >= MAX_MESSAGE_FORMAT_REFS) break;
    if (!Number.isInteger(ref.position) || !Number.isInteger(ref.length)) continue;
    if (ref.position < 0 || ref.length <= 0) continue;
    if (ref.position + ref.length > message.length) continue;
    if (typeof ref.noun !== "string" || ref.noun.length > MAX_FORMAT_REF_NOUN) continue;
    if (!isOutputIcon(ref.icon)) continue;
    if (message.slice(ref.position, ref.position + ref.length) !== ref.noun) continue;
    // Overlapping spans have no meaning and would let a renderer paint the same text twice.
    if (accepted.some(other => ref.position < other.position + other.length
                            && other.position < ref.position + ref.length)) {
      continue;
    }
    accepted.push({
      position: ref.position,
      length: ref.length,
      noun: ref.noun,
      icon: ref.icon,
    });
  }

  if (accepted.length === 0) return undefined;
  return accepted.toSorted((a, b) => a.position - b.position);
}
