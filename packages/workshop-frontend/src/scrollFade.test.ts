// Vitest runs under node, but the src/ tsconfig only has browser types — hence the suppressions.
// @ts-expect-error node builtin without @types/node
import { readFileSync } from 'node:fs'
// @ts-expect-error node builtin without @types/node
import { dirname, join } from 'node:path'
// @ts-expect-error node builtin without @types/node
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const srcDir = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(join(srcDir, name), 'utf8');

const scrollFadeCss = read('scrollFade.css');
const stylesCss = read('styles.css');

describe('vendored scroll-fade utilities', () => {
  it('carries attribution for shadcn/HextaUI', () => {
    expect(scrollFadeCss).toMatch(/shadcn-ui\/tailwind-styles/);
    expect(scrollFadeCss).toMatch(/hextaui\.com\/docs\/scroll-fade/);
    expect(scrollFadeCss).toMatch(/MIT/);
  });

  it('is wired into the global stylesheet', () => {
    expect(stylesCss).toContain('@import "./scrollFade.css"');
    expect(stylesCss).not.toContain('@utility scroll-fade');
  });

  it('fades statically where scroll() timelines are unsupported', () => {
    expect(scrollFadeCss).toMatch(/@supports not \(animation-timeline: scroll\(\)\)/);
  });

  it('reverses its inline fade in RTL', () => {
    expect(scrollFadeCss).toMatch(/\[dir="rtl"\]/);
  });
});
