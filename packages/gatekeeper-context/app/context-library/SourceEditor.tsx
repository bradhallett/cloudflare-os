/** CodeMirror source editor for non-markdown documents and markdown Edit mode. */

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { drawSelection, EditorView, keymap, lineNumbers } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import { useResolvedThemeMode } from "../bridge";

// Monospace font stack + syntax colors matching the Workshop's Monaco theme
// (workshop-frontend/src/components/monacoTheme.ts).
const monoFont =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

// Token colors matching the Workshop's Monaco theme, including its subdued markdown (headers use
// keyword purple, URLs green, the rest default).
const gadgetsHighlightStyleLight = HighlightStyle.define([
  { tag: t.comment, color: "#a39990", fontStyle: "italic" },
  {
    tag: [
      t.keyword,
      t.moduleKeyword,
      t.controlKeyword,
      t.operatorKeyword,
      t.definitionKeyword,
      t.modifier,
      t.self,
    ],
    color: "#8e3aa6",
  },
  { tag: t.operator, color: "#6b6157" },
  { tag: [t.string, t.special(t.string), t.regexp, t.escape], color: "#4d8a44" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#b56a1f" },
  { tag: [t.typeName, t.className, t.namespace], color: "#b56a1f" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#3a72c9" },
  { tag: [t.variableName, t.propertyName], color: "#1f1d1a" },
  { tag: t.constant(t.variableName), color: "#b56a1f" },
  { tag: t.standard(t.variableName), color: "#3a72c9" },
  { tag: [t.punctuation, t.separator, t.bracket, t.paren, t.brace], color: "#6b6157" },
  { tag: t.tagName, color: "#c14438" },
  { tag: t.attributeName, color: "#b56a1f" },
  { tag: t.attributeValue, color: "#4d8a44" },
  // Markdown: match Monaco (headers = keyword purple, URLs green, the rest default).
  { tag: t.heading, color: "#8e3aa6" },
  { tag: t.url, color: "#4d8a44" },
]);

const gadgetsEditorThemeLight = EditorView.theme(
  {
    "&": { color: "#1f1d1a", backgroundColor: "transparent", height: "100%", fontSize: "13px" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      fontFamily: monoFont,
      lineHeight: "1.7",
      overflow: "auto",
      scrollbarWidth: "thin",
      scrollbarColor: "var(--color-kumo-line) transparent",
    },
    ".cm-scroller::-webkit-scrollbar": { width: "4px", height: "4px" },
    ".cm-scroller::-webkit-scrollbar-thumb": {
      background: "var(--color-kumo-line)",
      borderRadius: "4px",
    },
    ".cm-scroller::-webkit-scrollbar-track": { background: "transparent" },
    ".cm-content": { padding: "12px 0", caretColor: "#1f1d1a" },
    ".cm-line": { padding: "0 16px" },
    ".cm-gutters": {
      backgroundColor: "transparent",
      border: "none",
      color: "#bdb7ae",
      fontSize: "12px",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 8px 0 14px",
      minWidth: "28px",
    },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#6b6157" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#1f1d1a" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "#b3d4ff",
    },
  },
  { dark: false },
);

const gadgetsHighlightStyleDark = HighlightStyle.define([
  { tag: t.comment, color: "#858396", fontStyle: "italic" },
  {
    tag: [
      t.keyword,
      t.moduleKeyword,
      t.controlKeyword,
      t.operatorKeyword,
      t.definitionKeyword,
      t.modifier,
      t.self,
    ],
    color: "#d8b4fe",
  },
  { tag: t.operator, color: "#b9b5c8" },
  { tag: [t.string, t.special(t.string), t.regexp, t.escape], color: "#86efac" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#fbbf24" },
  { tag: [t.typeName, t.className, t.namespace], color: "#fbbf24" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#93c5fd" },
  { tag: [t.variableName, t.propertyName], color: "#e8e6f0" },
  { tag: t.constant(t.variableName), color: "#fbbf24" },
  { tag: t.standard(t.variableName), color: "#93c5fd" },
  { tag: [t.punctuation, t.separator, t.bracket, t.paren, t.brace], color: "#b9b5c8" },
  { tag: t.tagName, color: "#fca5a5" },
  { tag: t.attributeName, color: "#fbbf24" },
  { tag: t.attributeValue, color: "#86efac" },
  { tag: t.heading, color: "#d8b4fe" },
  { tag: t.url, color: "#86efac" },
]);

const gadgetsEditorThemeDark = EditorView.theme(
  {
    "&": { color: "#e8e6f0", backgroundColor: "transparent", height: "100%", fontSize: "13px" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      fontFamily: monoFont,
      lineHeight: "1.7",
      overflow: "auto",
      scrollbarWidth: "thin",
      scrollbarColor: "var(--color-kumo-line) transparent",
    },
    ".cm-scroller::-webkit-scrollbar": { width: "4px", height: "4px" },
    ".cm-scroller::-webkit-scrollbar-thumb": {
      background: "var(--color-kumo-line)",
      borderRadius: "4px",
    },
    ".cm-scroller::-webkit-scrollbar-track": { background: "transparent" },
    ".cm-content": { padding: "12px 0", caretColor: "#e8e6f0" },
    ".cm-line": { padding: "0 16px" },
    ".cm-gutters": {
      backgroundColor: "transparent",
      border: "none",
      color: "#6d6880",
      fontSize: "12px",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 8px 0 14px",
      minWidth: "28px",
    },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#b9b5c8" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#e8e6f0" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "#4b3d66",
    },
  },
  { dark: true },
);

function editorThemeExtensions(mode: "light" | "dark"): Extension {
  return mode === "dark"
    ? [syntaxHighlighting(gadgetsHighlightStyleDark), gadgetsEditorThemeDark]
    : [syntaxHighlighting(gadgetsHighlightStyleLight), gadgetsEditorThemeLight];
}

// Pick a CodeMirror language grammar from the file extension; unknown types get none (plain text).
function languageForPath(path: string): Extension {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "md" || ext === "markdown" || ext === "mdx") return markdown();
  if (ext === "json") return json();
  if (ext === "yaml" || ext === "yml") return yaml();
  if (["js", "jsx", "mjs", "cjs", "ts", "tsx"].includes(ext))
    return javascript({ jsx: ext.endsWith("x"), typescript: ext.startsWith("ts") });
  return [];
}

/**
 * CodeMirror source editor (Monaco doesn't run in this sandbox). Soft-wrap keeps prose-heavy source
 * readable. Markdown uses MarkdownPreview in View mode; everything else uses this for both modes.
 */
export function SourceEditor({
  value,
  onChange,
  readOnly,
  path,
}: {
  value: string;
  onChange: (v: string) => void;
  readOnly?: boolean;
  path: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Keep the latest onChange without recreating the editor.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const editComp = useRef(new Compartment());
  const themeComp = useRef(new Compartment());
  const themeMode = useResolvedThemeMode();
  // Read the current mode without re-running the create-once effect below.
  const themeModeRef = useRef(themeMode);
  themeModeRef.current = themeMode;

  // Create the editor once. `path` is stable per mount, so the grammar is fixed for its lifetime.
  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          EditorView.lineWrapping,
          themeComp.current.of(editorThemeExtensions(themeModeRef.current)),
          languageForPath(path),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          editComp.current.of([
            EditorState.readOnly.of(!!readOnly),
            EditorView.editable.of(!readOnly),
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Create the editor once; external value changes flow through the sync effect below.
  }, []);

  // Sync external value changes without disturbing the cursor on user edits: skip when `value`
  // already matches the document (the common case, since edits flow out and back in as `value`).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (value !== current) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  // React to View/Edit toggling (readOnly flips in place).
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: editComp.current.reconfigure([
        EditorState.readOnly.of(!!readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  // React to light/dark changes (theme swaps in place).
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeComp.current.reconfigure(editorThemeExtensions(themeMode)),
    });
  }, [themeMode]);

  return <div ref={hostRef} className="h-full overflow-hidden" />;
}
