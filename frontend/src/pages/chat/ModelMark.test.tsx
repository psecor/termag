// @vitest-environment jsdom
// The model makers' marks on a session card (pages/chat/ModelMark.tsx).
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import type { ModelMaker } from '../../chat/modelMark';
import { ModelMark } from './ModelMark';

const MAKERS: ModelMaker[] = ['claude', 'kimi', 'glm', 'deepseek', 'qwen', 'llama', 'fireworks', 'codex', 'cursor', 'devin', 'gemini', 'other'];

function draw(maker: ModelMaker) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  const root = createRoot(host);
  act(() => root.render(<ModelMark maker={maker} label={maker} />));
  const svg = host.querySelector('svg');
  act(() => root.unmount());
  return svg;
}

describe('ModelMark', () => {
  it("draws the makers' own marks where they can be used cleanly, and stand-ins for the rest", () => {
    const kinds = Object.fromEntries(MAKERS.map(m => [m, draw(m)?.getAttribute('data-mark')]));
    expect(kinds).toEqual({
      claude: 'real', kimi: 'real', glm: 'real', deepseek: 'real', qwen: 'real', cursor: 'real',
      llama: 'stand-in', fireworks: 'stand-in', codex: 'stand-in', devin: 'stand-in', gemini: 'stand-in', other: 'stand-in',
    });
  });

  it("keeps the real marks on Simple Icons' 24 px grid, and a dark brand's mark in the text colour", () => {
    const claude = draw('claude')!;
    expect(claude.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(claude.querySelector('path')?.getAttribute('fill')).toBe('#D97757');
    for (const m of ['cursor', 'kimi', 'glm'] as const) expect(draw(m)!.querySelector('path')?.getAttribute('fill')).toBe('var(--text-primary)');
  });
});
