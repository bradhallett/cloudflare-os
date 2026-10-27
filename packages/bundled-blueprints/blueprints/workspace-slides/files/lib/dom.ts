/** Small DOM/SVG helpers shared across the deck editor. */

/* ----------------------- DOM helpers -------------------------------------
 *
 * `el` is the ui library's element builder. The SVG helpers below stay here:
 * slide components draw into the SVG namespace, which the library's HTML-only
 * builder does not reach. */
export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | null | undefined> = {},
  children: (Node | null | undefined)[] = [],
): SVGElementTagNameMap[K] {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (v == null) continue;
    e.setAttribute(k, String(v));
  }
  for (const c of (children || [])) if (c) e.appendChild(c);
  return e;
}
/* `-webkit-backdrop-filter` is set beside `backdropFilter` for Safari. The
 * CSSOM exposes it as `WebkitBackdropFilter`, which lib.dom does not declare,
 * so the style objects that carry it are asserted to this. */
export type VendorStyle = Partial<CSSStyleDeclaration> & { WebkitBackdropFilter?: string };

export function svgFromString(s: string): ChildNode {
  const t = document.createElement("template");
  t.innerHTML = s.trim();
  // Callers pass literal markup, so the template always holds a node.
  return t.content.firstChild!;
}
export function hexA(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  } as Record<string, string>)[ch]);
}
export function escapeRegex(s: string): string {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
