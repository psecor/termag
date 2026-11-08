// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolItem } from '../../chat/toolRuns';
import { createHeadingStore, HeadingStoreContext, type HeadingStore } from '../../chat/toolGroupHeadings';
import { ToolCard, ToolRun } from './ToolCards';

function bash(id: string, command: string, over: Partial<ToolItem> = {}, description?: string): ToolItem {
  const input = description ? { command, description } : { command };
  return { kind: 'tool', key: `tool:${id}`, id, name: 'Bash', input, inputJson: '', result: 'ok', isError: false, done: true, ...over };
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
const intents = () => [...host.querySelectorAll('.sdk-tool-intent')].map(e => e.textContent);

describe('ToolRun', () => {
  it('shows one closed row for the run, and every call once opened', () => {
    const tools = Array.from({ length: 7 }, (_, i) => bash(String(i), `make step-${i}`));
    act(() => root.render(<ToolRun runKey="run:tool:t" tools={tools} />));
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
    act(() => root.render(<ToolRun runKey="run:tool:t" tools={tools} />));
    expect(host.querySelector('.sdk-run')!.getAttribute('data-state')).toBe('done');
    expect(host.querySelector('.sdk-run-head .sdk-tool-mark')!.textContent).toBe('✓');
    expect(host.querySelector('.sdk-run-failed')!.textContent).toBe('1 failed');
    expect(host.querySelector('.sdk-run-failed')!.getAttribute('title')).toBe('Later calls went on past these');
    expect(cards()).toEqual(['curl -s http://x']);
    expect(host.querySelector('.sdk-tool')!.getAttribute('data-state')).toBe('error');
  });

  it('marks the run failed when its last call failed', () => {
    const tools = [bash('1', 'ls'), bash('2', 'npm run build', { isError: true, result: 'error TS2322' })];
    act(() => root.render(<ToolRun runKey="run:tool:t" tools={tools} />));
    expect(host.querySelector('.sdk-run')!.getAttribute('data-state')).toBe('error');
    expect(host.querySelector('.sdk-run-head .sdk-tool-mark')!.textContent).toBe('✗');
    expect(host.querySelector('.sdk-run-failed')!.hasAttribute('title')).toBe(false);
  });

  it('says the call running now on the step line of a closed run, not in a card that comes and goes', () => {
    const tools = [bash('1', 'ls'), bash('2', 'make test', { done: false, result: null })];
    act(() => root.render(<ToolRun runKey="run:tool:t" tools={tools} settled={false} live />));
    expect(host.querySelector('.sdk-run')!.getAttribute('data-state')).toBe('running');
    expect(cards()).toEqual([]);
    expect(host.querySelector('.sdk-run-body')).toBeNull();
    expect(host.querySelector('.sdk-run-step')!.textContent).toBe('Bash');
  });

  it('keeps a live run one height as its calls start and end: the step line stays, no card comes in or goes', () => {
    const shape = () => ({ body: host.querySelector('.sdk-run-body') != null, step: host.querySelector('.sdk-run-step')?.textContent ?? null });
    const run = (tools: ToolItem[]) => act(() => root.render(<ToolRun runKey="run:tool:t" tools={tools} settled={false} live />));
    run([bash('1', 'ls', {}, 'List the root'), bash('2', 'npm test', { done: false, result: null }, 'Run the tests')]);
    expect(shape()).toEqual({ body: false, step: 'Run the tests' });
    // That call ends; Claude thinks before the next one.
    run([bash('1', 'ls', {}, 'List the root'), bash('2', 'npm test', {}, 'Run the tests')]);
    expect(shape()).toEqual({ body: false, step: 'Run the tests' });
    run([bash('1', 'ls', {}, 'List the root'), bash('2', 'npm test', {}, 'Run the tests'), bash('3', 'git diff', { done: false, result: null }, 'Show the diff')]);
    expect(shape()).toEqual({ body: false, step: 'Show the diff' });
  });
});

describe('ToolRun: described calls', () => {
  const tools = [
    bash('1', 'ls -la', {}, 'List the repository root'),
    bash('2', 'npm run lint', { isError: true, result: 'npm error Missing script: "lint"' }, 'Run the linter'),
    bash('3', 'grep -rn TODO .', {}, 'Find open TODOs'),
    bash('4', 'du -sh .', {}, 'Measure the checkout size'),
  ];

  it('heads the run with what it was for, keeps the counts on hover and the failures beside it', () => {
    act(() => root.render(<ToolRun runKey="run:tool:t" tools={tools} />));
    const title = host.querySelector('.sdk-run-title')!;
    expect(title.textContent).toBe('Measure the checkout size · +3 more');
    expect(title.getAttribute('title')).toBe('Ran 4 commands');
    expect(host.querySelector('.sdk-run-head .sdk-tool-mark')!.textContent).toBe('✓');
    expect(host.querySelector('.sdk-run-failed')!.textContent).toBe('1 failed');
  });

  it('leads each row with its description and keeps the command beside it', () => {
    act(() => root.render(<ToolRun runKey="run:tool:t" tools={tools} />));
    act(() => head().click());
    expect(intents()).toEqual(['List the repository root', 'Run the linter', 'Find open TODOs', 'Measure the checkout size']);
    expect(cards()).toEqual(['ls -la', 'npm run lint', 'grep -rn TODO .', 'du -sh .']);
    expect(host.querySelector('.sdk-tool')!.hasAttribute('data-intent')).toBe(true);

    act(() => host.querySelectorAll<HTMLButtonElement>('.sdk-tool-head')[1].click());
    expect(host.querySelector('.sdk-tool-input')!.textContent).toBe('$ npm run lint');
  });

  it('says what the running call is doing on a muted line under the heading, not on it', () => {
    const running = [tools[0], bash('4', 'termag ask …', { done: false, result: null }, "Wait for the sign-in agent's reply")];
    act(() => root.render(<ToolRun runKey="run:tool:t" tools={running} settled={false} />));
    expect(host.querySelector('.sdk-run-title')!.textContent).toBe("List the repository root · Wait for the sign-in agent's reply");
    expect(host.querySelector('.sdk-run-step')!.textContent).toBe("Wait for the sign-in agent's reply");
    // Said once, on that line: no card of its own while the run is shut.
    expect(intents()).toEqual([]);
  });

  it('keeps the counts, with no hover text, for calls that say nothing', () => {
    act(() => root.render(<ToolRun runKey="run:tool:t" tools={[bash('1', 'ls'), bash('2', 'pwd')]} />));
    expect(host.querySelector('.sdk-run-title')!.textContent).toBe('Ran 2 commands');
    expect(host.querySelector('.sdk-run-title')!.hasAttribute('title')).toBe(false);
  });
});

describe('ToolRun: a heading written once', () => {
  const tools = [
    bash('1', 'ls -la', {}, 'List the repository root'),
    bash('2', 'npm run lint', { isError: true, result: 'missing' }, 'Run the linter'),
    bash('3', 'du -sh .', {}, 'Measure the checkout size'),
  ];
  const title = () => host.querySelector('.sdk-run-title')!;
  const source = () => host.querySelector('.sdk-run')!.getAttribute('data-source');
  const step = () => host.querySelector('.sdk-run-step')?.textContent ?? null;
  const inChat = (store: HeadingStore | null, run: React.ReactElement) => <HeadingStoreContext.Provider value={store}>{run}</HeadingStoreContext.Provider>;
  const lead = 'Let me survey how the repo is set up.';

  it('holds a placeholder while the heading is on its way, fades it in once, and never changes it after', () => {
    const store = createHeadingStore();
    const running = [tools[0], bash('2', 'npm run lint', { done: false, result: null }, 'Run the linter')];
    act(() => root.render(inChat(store, <ToolRun runKey="run:tool:1" tools={running} leadIn={lead} settled={false} live />)));
    expect(source()).toBe('pending');
    expect(title().classList.contains('sdk-run-placeholder')).toBe(true);
    // No words, not even the lead-in, until Haiku answers.
    expect(title().textContent).toBe('');
    act(() => store.add('run:tool:2', { heading: 'Another run' }));
    expect(source()).toBe('pending');
    act(() => store.add('run:tool:1', { heading: 'Check the repo builds and lints' }));
    expect(title().textContent).toBe('Check the repo builds and lints');
    expect(title().hasAttribute('data-swapped')).toBe(true);
    // The run goes on and ends; a second answer for it comes: the heading stays.
    act(() => store.add('run:tool:1', { heading: 'Something else' }));
    act(() => root.render(inChat(store, <ToolRun runKey="run:tool:1" tools={tools} leadIn={lead} settled live={false} />)));
    expect(title().textContent).toBe('Check the repo builds and lints');
    expect(source()).toBe('model');
  });

  it('shows the kept heading at once on a reload, with no placeholder and no fade', () => {
    const store = createHeadingStore();
    store.load({ 'run:tool:1': { heading: 'Check the repo builds and lints' }, bad: 7 });
    act(() => root.render(inChat(store, <ToolRun runKey="run:tool:1" tools={tools} leadIn={lead} live={false} />)));
    expect(title().textContent).toBe('Check the repo builds and lints');
    expect(title().hasAttribute('data-swapped')).toBe(false);
  });

  it('chooses the fallback once when Haiku fails: the lead-in, else the labels of the calls it had then', () => {
    const store = createHeadingStore();
    act(() => root.render(inChat(store, <ToolRun runKey="run:tool:1" tools={tools.slice(0, 2)} live settled={false} />)));
    act(() => store.add('run:tool:1', { failed: true, calls: 2 }));
    expect(title().textContent).toBe('List the repository root · Run the linter');
    expect(source()).toBe('calls');
    act(() => root.render(inChat(store, <ToolRun runKey="run:tool:1" tools={[...tools, bash('4', 'pwd', {}, 'Print the directory')]} />)));
    // Fixed, though the run grew.
    expect(title().textContent).toBe('List the repository root · Run the linter');
    // A reload makes the same choice from the kept failure.
    act(() => root.unmount());
    root = createRoot(host);
    const reloaded = createHeadingStore();
    reloaded.load({ 'run:tool:1': { failed: true, calls: 2 } });
    act(() => root.render(inChat(reloaded, <ToolRun runKey="run:tool:1" tools={[...tools, bash('4', 'pwd', {}, 'Print the directory')]} />)));
    expect(title().textContent).toBe('List the repository root · Run the linter');
    // With a lead-in, the failure's fallback is the lead-in.
    const withLead = createHeadingStore();
    withLead.load({ 'run:tool:1': { failed: true, calls: 2 } });
    act(() => root.render(inChat(withLead, <ToolRun runKey="run:tool:1" tools={tools} leadIn={lead} key="other" />)));
    expect(title().textContent).toBe('Survey how the repo is set up');
  });

  it('keeps waiting for the answer already on its way when the turn ends, and shows it once', () => {
    const store = createHeadingStore();
    act(() => root.render(inChat(store, <ToolRun runKey="run:tool:1" tools={tools} leadIn={lead} settled={false} live />)));
    expect(source()).toBe('pending');
    // The turn ends before Haiku answers: the run is no longer live, but its ask is still out.
    act(() => root.render(inChat(store, <ToolRun runKey="run:tool:1" tools={tools} leadIn={lead} settled live={false} />)));
    expect(source()).toBe('pending');
    act(() => store.add('run:tool:1', { heading: 'Check the repo builds and lints' }));
    // The same words a reload reads from history.
    expect(title().textContent).toBe('Check the repo builds and lints');
    expect(title().hasAttribute('data-swapped')).toBe(true);
  });

  it('after the turn ends, a failure frame still picks the fallback once', () => {
    const store = createHeadingStore();
    act(() => root.render(inChat(store, <ToolRun runKey="run:tool:1" tools={tools.slice(0, 2)} live settled={false} />)));
    act(() => root.render(inChat(store, <ToolRun runKey="run:tool:1" tools={tools} live={false} />)));
    act(() => store.add('run:tool:1', { failed: true, calls: 2 }));
    expect(title().textContent).toBe('List the repository root · Run the linter');
  });

  it('gives up waiting after a while, even once the turn has ended', () => {
    vi.useFakeTimers();
    try {
      const store = createHeadingStore();
      act(() => root.render(inChat(store, <ToolRun runKey="run:tool:1" tools={tools} leadIn={lead} live />)));
      act(() => root.render(inChat(store, <ToolRun runKey="run:tool:1" tools={tools} leadIn={lead} live={false} />)));
      expect(source()).toBe('pending');
      act(() => { vi.advanceTimersByTime(30_000); });
      expect(title().textContent).toBe('Survey how the repo is set up');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a remount does not restart the wait: the placeholder never outlasts HEADING_WAIT_MS', () => {
    vi.useFakeTimers();
    try {
      const store = createHeadingStore();
      act(() => root.render(inChat(store, <ToolRun runKey="run:tool:1" tools={tools} live />)));
      act(() => { vi.advanceTimersByTime(20_000); });
      // The transcript redrawn (a history reload re-keys the reply): a new ToolRun for the same run.
      act(() => root.unmount());
      root = createRoot(host);
      act(() => root.render(inChat(store, <ToolRun runKey="run:tool:1" tools={tools} live />)));
      expect(source()).toBe('pending');
      act(() => { vi.advanceTimersByTime(10_000); });
      expect(title().textContent).toBe('List the repository root · Run the linter · Measure the checkout size');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a remount keeps the words already chosen, whatever answer comes after', () => {
    vi.useFakeTimers();
    try {
      const store = createHeadingStore();
      act(() => root.render(inChat(store, <ToolRun runKey="run:tool:1" tools={tools} leadIn={lead} live />)));
      act(() => { vi.advanceTimersByTime(30_000); });
      expect(title().textContent).toBe('Survey how the repo is set up');
      act(() => store.add('run:tool:1', { heading: 'Too late' }));
      act(() => root.unmount());
      root = createRoot(host);
      act(() => root.render(inChat(store, <ToolRun runKey="run:tool:1" tools={tools} leadIn={lead} live />)));
      expect(title().textContent).toBe('Survey how the repo is set up');
    } finally {
      vi.useRealTimers();
    }
  });

  it('an empty or malformed heading is a failure: the fallback at once, never a lasting placeholder', () => {
    const store = createHeadingStore();
    act(() => root.render(inChat(store, <ToolRun runKey="run:tool:1" tools={tools} leadIn={lead} live />)));
    act(() => store.add('run:tool:1', { heading: '   ' } as never));
    expect(title().textContent).toBe('Survey how the repo is set up');
    const other = createHeadingStore();
    other.load({ 'run:tool:2': { heading: '' }, 'run:tool:3': { nonsense: true } });
    act(() => root.render(inChat(other, <ToolRun runKey="run:tool:2" tools={tools} live />)));
    expect(source()).toBe('calls');
  });

  it('a run in a turn whose box is not asking for headings never waits', () => {
    act(() => root.render(inChat(createHeadingStore(), <ToolRun runKey="run:tool:1" tools={tools} leadIn={lead} live asks={false} />)));
    expect(source()).toBe('lead-in');
    expect(host.querySelector('.sdk-run-placeholder')).toBeNull();
  });

  it('a lone call is a card with its own label, never a placeholder', () => {
    act(() => root.render(inChat(createHeadingStore(), <ToolCard item={bash('1', 'git commit -m x', {}, 'Commit the change')} />)));
    expect(host.querySelector('.sdk-run-placeholder')).toBeNull();
    expect(intents()).toEqual(['Commit the change']);
    act(() => root.render(inChat(createHeadingStore(), <ToolCard item={bash('2', 'ls -la')} />)));
    expect(host.querySelector('.sdk-tool-title')!.textContent).toBe('Bash');
    expect(cards()).toEqual(['ls -la']);
  });

  it('gives up waiting after a while and keeps the fallback it chose', () => {
    vi.useFakeTimers();
    try {
      const store = createHeadingStore();
      act(() => root.render(inChat(store, <ToolRun runKey="run:tool:1" tools={tools} leadIn={lead} live />)));
      expect(source()).toBe('pending');
      act(() => { vi.advanceTimersByTime(30_000); });
      expect(title().textContent).toBe('Survey how the repo is set up');
      act(() => store.add('run:tool:1', { heading: 'Too late' }));
      expect(title().textContent).toBe('Survey how the repo is set up');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a run from history with no answer (an older box) takes its fallback at once, never a placeholder', () => {
    act(() => root.render(inChat(createHeadingStore(), <ToolRun runKey="run:tool:9" tools={tools} />)));
    expect(title().textContent).toBe('List the repository root · Run the linter · Measure the checkout size');
    expect(source()).toBe('calls');
  });

  it('with the flag off for this viewer: the lead-in, no placeholder', () => {
    act(() => root.render(inChat(null, <ToolRun runKey="run:tool:8" tools={tools} leadIn={lead} live />)));
    expect(source()).toBe('lead-in');
  });

  it('shows the step line only while the run runs or may grow', () => {
    const store = createHeadingStore();
    store.add('run:tool:7', { heading: 'Check the repo builds and lints' });
    const running = [...tools.slice(0, 2), bash('3', 'du -sh .', { done: false, result: null }, 'Measure the checkout size')];
    act(() => root.render(inChat(store, <ToolRun runKey="run:tool:7" tools={running} settled={false} live />)));
    expect(title().textContent).toBe('Check the repo builds and lints');
    expect(step()).toBe('Measure the checkout size');
    // Between two calls: none running, but more may come.
    act(() => root.render(inChat(store, <ToolRun runKey="run:tool:7" tools={tools} settled={false} live />)));
    expect(step()).toBe('Measure the checkout size');
    act(() => root.render(inChat(store, <ToolRun runKey="run:tool:7" tools={tools} settled live />)));
    expect(step()).toBeNull();
    expect(title().textContent).toBe('Check the repo builds and lints');
  });
});

describe('ToolCard', () => {
  it('shows a subagent call\'s description once', () => {
    const agent: ToolItem = { kind: 'tool', key: 'tool:a', id: 'a', name: 'Agent', input: { description: 'Find the sign-in flow', prompt: 'Look…' }, inputJson: '', result: 'ok', isError: false, done: true };
    act(() => root.render(<ToolCard item={agent} />));
    expect(intents()).toEqual(['Find the sign-in flow']);
    expect(cards()).toEqual([]);
  });

  it('shows a bare command as the detail, as before', () => {
    act(() => root.render(<ToolCard item={bash('1', 'make test')} />));
    expect(intents()).toEqual([]);
    expect(cards()).toEqual(['make test']);
    expect(host.querySelector('.sdk-tool')!.hasAttribute('data-intent')).toBe(false);
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
