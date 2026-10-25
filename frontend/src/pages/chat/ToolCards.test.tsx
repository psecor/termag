// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolItem } from '../../chat/toolRuns';
import { ToolCard, ToolRun } from './ToolCards';

function bash(id: string, command: string, over: Partial<ToolItem> = {}): ToolItem {
  return { kind: 'tool', key: `tool:${id}`, id, name: 'Bash', input: { command }, inputJson: '', result: 'ok', isError: false, done: true, ...over };
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  root = createRoot(host);
});

afterEach(() => { act(() => root.unmount()); });

const cards = () => [...host.querySelectorAll('.sdk-tool-detail')].map(e => e.textContent);
const head = () => host.querySelector<HTMLButtonElement>('.sdk-run-head')!;

describe('ToolRun', () => {
  it('shows one closed row for the run, and every call once opened', () => {
    const tools = Array.from({ length: 7 }, (_, i) => bash(String(i), `make step-${i}`));
    act(() => root.render(<ToolRun tools={tools} />));
    expect(head().textContent).toContain('Ran 7 commands');
    expect(head().getAttribute('aria-expanded')).toBe('false');
    expect(cards()).toEqual([]);

    act(() => head().click());
    expect(head().getAttribute('aria-expanded')).toBe('true');
    expect(cards()).toEqual(tools.map((_, i) => `make step-${i}`));

    act(() => head().click());
    expect(cards()).toEqual([]);
  });

  it('keeps a failed call visible while the run is closed, and says how many failed', () => {
    const tools = [bash('1', 'ls'), bash('2', 'curl -s http://x', { isError: true, result: 'refused' }), bash('3', 'pwd')];
    act(() => root.render(<ToolRun tools={tools} />));
    expect(host.querySelector('.sdk-run')!.getAttribute('data-state')).toBe('done');
    expect(host.querySelector('.sdk-run-head .sdk-tool-mark')!.textContent).toBe('✓');
    expect(host.querySelector('.sdk-run-failed')!.textContent).toBe('1 failed');
    expect(host.querySelector('.sdk-run-failed')!.getAttribute('title')).toBe('Later calls went on past these');
    expect(cards()).toEqual(['curl -s http://x']);
    expect(host.querySelector('.sdk-tool')!.getAttribute('data-state')).toBe('error');
  });

  it('marks the run failed when its last call failed', () => {
    const tools = [bash('1', 'ls'), bash('2', 'npm run build', { isError: true, result: 'error TS2322' })];
    act(() => root.render(<ToolRun tools={tools} />));
    expect(host.querySelector('.sdk-run')!.getAttribute('data-state')).toBe('error');
    expect(host.querySelector('.sdk-run-head .sdk-tool-mark')!.textContent).toBe('✗');
    expect(host.querySelector('.sdk-run-failed')!.hasAttribute('title')).toBe(false);
  });

  it('shows the call running now under a closed run', () => {
    const tools = [bash('1', 'ls'), bash('2', 'make test', { done: false, result: null })];
    act(() => root.render(<ToolRun tools={tools} />));
    expect(host.querySelector('.sdk-run')!.getAttribute('data-state')).toBe('running');
    expect(cards()).toEqual(['make test']);
  });
});

describe('ToolCard: a Skill call', () => {
  const body = 'Base directory for this skill: /h/.claude/skills/termag-spaces\n\n# termag spaces';
  const skill = (over: Partial<ToolItem> = {}): ToolItem => ({
    kind: 'tool', key: 'tool:s1', id: 's1', name: 'Skill', input: { skill: 'termag-spaces' }, inputJson: '',
    result: 'Launching skill: termag-spaces', isError: false, done: true, skill: body, ...over,
  });

  it('is one closed row naming the skill, whose instructions open underneath', () => {
    act(() => root.render(<ToolCard item={skill()} />));
    const button = host.querySelector<HTMLButtonElement>('.sdk-tool-head')!;
    expect(button.textContent).toContain('Used skill');
    expect(host.querySelector('.sdk-skill-name')!.textContent).toBe('termag-spaces');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.sdk-tool-result')).toBeNull();

    act(() => button.click());
    expect(host.querySelector('.sdk-tool-result')!.textContent).toBe(body);
    expect(host.querySelector('.sdk-tool-input')).toBeNull();
  });

  it('says it is loading while the call runs', () => {
    act(() => root.render(<ToolCard item={skill({ done: false, result: null, skill: undefined })} />));
    expect(host.querySelector('.sdk-tool-head')!.textContent).toContain('Loading skill');
  });
});
