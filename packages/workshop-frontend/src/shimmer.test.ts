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

const shimmerCss = read('shimmer.css');
const stylesCss = read('styles.css');
const moduleCss = read('ChatInterface.module.css');
const transcript = read('features/chat/ChatTranscript.tsx');

describe('vendored shimmer utility', () => {
  it('carries MIT attribution for HextaUI/shadcn', () => {
    expect(shimmerCss).toMatch(/hextaui\.com\/docs\/shimmer/);
    expect(shimmerCss).toMatch(/MIT/i);
  });

  it('is wired into the global stylesheet', () => {
    expect(stylesCss).toContain('@import "./shimmer.css"');
  });

  it('derives its band from currentColor, not color literals', () => {
    expect(shimmerCss).toContain('--_base: currentColor');
    expect(shimmerCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('degrades to static text under reduced motion and reverses in RTL', () => {
    expect(shimmerCss).toMatch(/prefers-reduced-motion: reduce/);
    expect(shimmerCss).toContain('-webkit-text-fill-color: currentColor');
    expect(shimmerCss).toMatch(/\[dir="rtl"\]/);
    expect(shimmerCss).toContain('animation-direction: reverse');
  });

  it('replaced the hand-rolled .thinkingShimmer', () => {
    expect(moduleCss).not.toContain('thinkingShimmer');
    expect(moduleCss).not.toContain('thinking-shimmer');
    expect(transcript).not.toContain('thinkingShimmer');
    expect(transcript).toMatch(/inline-flex shimmer /);
  });
});
