import { useRef, useState, type RefObject } from "react";

import { slashCommandTokenKey } from "./slash-commands/slashCommandInput";
import { snapCaretOutOfRanges } from "../../../components/chat/composer-tokens";
import { removeComposerDocumentToken, type ComposerDocument } from "./composerDocument";
import type { ComposerMirrorHandle } from "./inline-items/ComposerMirror";

/** What {@link useComposerTokens} edits and addresses; see the hook. */
export interface UseComposerTokensArgs {
  /** The document's current text, capsules, formats, and resolved command. */
  document: ComposerDocument;
  /** Records a user edit of the draft (storage + presentation bookkeeping). */
  recordDraftEdit: () => void;
  /** Replaces the whole document after a token edit. */
  replaceDocument: (document: ComposerDocument) => void;
  /** The textarea the caret lives in. */
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** The mirror whose token spans the pointer is hit-tested against. */
  mirrorRef: RefObject<ComposerMirrorHandle | null>;
}

/**
 * The composer's token/caret state machine: capsules, formats, and the resolved slash
 * command are addressed by the caret as single units. Ranges are read from refs so
 * callbacks scheduled off a render (rAF, awaited RPC) see current positions, and the
 * slash-picker caret refreshes only when its token changes — plain caret movement
 * re-renders nothing.
 */
export function useComposerTokens({
  document,
  recordDraftEdit,
  replaceDocument,
  textareaRef,
  mirrorRef,
}: UseComposerTokensArgs) {
  const { text, capsules, formats, command } = document;
  // The caret the slash command picker parses at.
  const [cursorPosition, setCursorPosition] = useState(0);
  const pickerCaretRef = useRef<{key: string | null; text: string}>({key: null, text: ""});
  const textRef = useRef(text);
  textRef.current = text;
  const capsulesRef = useRef(capsules);
  capsulesRef.current = capsules;
  const formatsRef = useRef(formats);
  formatsRef.current = formats;
  const commandRef = useRef(command);
  commandRef.current = command;

  // Ranges the caret addresses as single units: resource capsules, formats, and the
  // resolved command.
  const currentTokenRanges = () => [
    ...capsulesRef.current.map(({start, length}) => ({start, length})),
    ...(commandRef.current ? [{start: commandRef.current.start, length: commandRef.current.length}] : []),
    ...formatsRef.current.map(({start, length}) => ({start, length})),
  ];

  const currentComposerDocument = (): ComposerDocument => ({
    text: textRef.current,
    capsules: capsulesRef.current,
    formats: formatsRef.current,
    command: commandRef.current,
  });

  // Refreshes the picker's copy of the caret only when its command token changes rather
  // than on every movement; plain caret movement then re-renders nothing.
  const syncPickerCaret = (position: number) => {
    const text = textRef.current;
    const key = slashCommandTokenKey(text, position);
    if (key !== pickerCaretRef.current.key || text !== pickerCaretRef.current.text) {
      pickerCaretRef.current = {key, text};
      setCursorPosition(position);
    }
  };

  const moveCaret = (position: number) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.setSelectionRange(position, position);
    syncPickerCaret(position);
  };

  const removeTokenAt = (range: {start: number; length: number}) => {
    recordDraftEdit();
    const transition = removeComposerDocumentToken(currentComposerDocument(), range);
    replaceDocument(transition.document);
    requestAnimationFrame(() => moveCaret(transition.caret));
  };

  // Hit-tests the pointer against the mirror's token spans, which lay out identically to
  // the textarea's text. Hit-testing forces layout, so avoid it with no tokens.
  const tokenAtPoint = (clientX: number, clientY: number):
      {start: number; edge: number} | null => {
    if (capsulesRef.current.length === 0 && !commandRef.current
        && formatsRef.current.length === 0) {
      return null;
    }
    return mirrorRef.current?.tokenAtPoint(clientX, clientY) ?? null;
  };

  const snapCaretOutOfTokens = (position: number, direction: "nearest" | "left" | "right") =>
    snapCaretOutOfRanges(position, currentTokenRanges(), direction);

  return {
    /** The caret the slash command picker parses at (see {@link syncPickerCaret}). */
    cursorPosition,
    currentTokenRanges,
    currentComposerDocument,
    /** The document's current text, for callbacks that run after an await or a rAF. */
    currentText: () => textRef.current,
    syncPickerCaret,
    moveCaret,
    removeTokenAt,
    tokenAtPoint,
    snapCaretOutOfTokens,
  };
}
