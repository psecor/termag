// @vitest-environment jsdom
import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isInteractiveTarget, shouldFocusComposer, type TranscriptClick, useTranscriptFocus } from './transcriptFocus';

const plain: TranscriptClick = {
  pointerType: 'mouse', button: 0, modified: false, selectionText: '',
  targetIsInteractive: false, composerDisabled: false, composerFocused: false,
};

describe('shouldFocusComposer', () => {
  it('focuses on a plain mouse or pen click', () => {
    expect(shouldFocusComposer(plain)).toBe(true);
    expect(shouldFocusComposer({ ...plain, pointerType: 'pen' })).toBe(true);
  });

  it('leaves taps and keyboard clicks alone', () => {
    expect(shouldFocusComposer({ ...plain, pointerType: 'touch' })).toBe(false);
    expect(shouldFocusComposer({ ...plain, pointerType: null })).toBe(false);
  });

  it('leaves modified and non-primary clicks alone', () => {
    expect(shouldFocusComposer({ ...plain, modified: true })).toBe(false);
    expect(shouldFocusComposer({ ...plain, button: 1 })).toBe(false);
    expect(shouldFocusComposer({ ...plain, button: 2 })).toBe(false);
  });

  it('keeps a selection the click made', () => {
    expect(shouldFocusComposer({ ...plain, selectionText: 'npm run build' })).toBe(false);
  });

  it('lets interactive transcript content keep the click', () => {
    expect(shouldFocusComposer({ ...plain, targetIsInteractive: true })).toBe(false);
  });

  it('does nothing when the composer is disabled or already focused', () => {
    expect(shouldFocusComposer({ ...plain, composerDisabled: true })).toBe(false);
    expect(shouldFocusComposer({ ...plain, composerFocused: true })).toBe(false);
  });
});

describe('isInteractiveTarget', () => {
  let box: HTMLDivElement;
  beforeEach(() => {
    box = document.createElement('div');
    box.innerHTML = `
      <p id="text">plain <code id="code">code</code></p>
      <a id="link" href="https://example.com"><span id="in-link">a link</span></a>
      <div class="sdk-tool"><button id="tool"><span id="in-tool">Read</span></button></div>
      <details><summary id="summary">more</summary><p id="detail">hidden</p></details>
      <div role="button" id="role">role button</div>
      <div tabindex="0" id="tab0">focusable</div>
      <div tabindex="-1" id="tabneg">programmatic focus only</div>
      <div contenteditable="true" id="edit">editable</div>
      <label id="label">a label</label>`;
    document.body.appendChild(box);
  });
  afterEach(() => box.remove());
  const at = (id: string) => isInteractiveTarget(document.getElementById(id), box);

  it('is false for prose, code and details content', () => {
    expect(at('text')).toBe(false);
    expect(at('code')).toBe(false);
    expect(at('detail')).toBe(false);
    expect(at('tabneg')).toBe(false);
  });

  it('is true for links, buttons and their insides', () => {
    expect(at('link')).toBe(true);
    expect(at('in-link')).toBe(true);
    expect(at('tool')).toBe(true);
    expect(at('in-tool')).toBe(true);
  });

  it('is true for summaries, roles, focusable, editable and label elements', () => {
    for (const id of ['summary', 'role', 'tab0', 'edit', 'label']) expect(at(id)).toBe(true);
  });

  it('ignores interactive ancestors outside the transcript', () => {
    const outer = document.createElement('div');
    outer.setAttribute('role', 'button');
    document.body.appendChild(outer);
    outer.appendChild(box);
    expect(at('text')).toBe(false);
    outer.remove();
  });

  it('is false for the transcript itself and for non-elements', () => {
    box.tabIndex = 0;
    expect(isInteractiveTarget(box, box)).toBe(false);
    expect(isInteractiveTarget(null, box)).toBe(false);
    expect(isInteractiveTarget(document.getElementById('text')!.firstChild, box)).toBe(false);
  });
});

function Harness({ enabled }: { enabled: boolean }) {
  const composer = useRef<HTMLTextAreaElement>(null);
  const focus = useTranscriptFocus(composer, enabled);
  return (
    <div>
      <div className="chat-transcript" data-testid="transcript" {...focus}>
        <p id="text">Claude said something.</p>
        <a id="link" href="#reply">a link</a>
        <button id="retry" type="button">Retry</button>
      </div>
      <textarea ref={composer} disabled={!enabled} />
    </div>
  );
}

describe('useTranscriptFocus', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.getSelection()?.removeAllRanges();
  });

  const render = (enabled = true) => act(() => root.render(<Harness enabled={enabled} />));
  const textarea = () => container.querySelector('textarea')!;
  // jsdom may lack PointerEvent; React reads pointerType off the native event either way.
  function click(id: string, pointerType: string | null = 'mouse') {
    const el = container.querySelector(`#${id}`)!;
    act(() => {
      if (pointerType) {
        const down = new MouseEvent('pointerdown', { bubbles: true, button: 0 });
        Object.defineProperty(down, 'pointerType', { value: pointerType });
        el.dispatchEvent(down);
      }
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    });
  }

  it('puts the cursor in the composer when plain transcript text is clicked', () => {
    render();
    click('text');
    expect(document.activeElement).toBe(textarea());
  });

  it('leaves links and buttons in the transcript alone', () => {
    render();
    click('link');
    expect(document.activeElement).not.toBe(textarea());
    click('retry');
    expect(document.activeElement).not.toBe(textarea());
  });

  it('leaves taps and keyboard clicks alone', () => {
    render();
    click('text', 'touch');
    expect(document.activeElement).not.toBe(textarea());
    click('text', null);
    expect(document.activeElement).not.toBe(textarea());
  });

  it('does not reuse a mouse pointerdown for a later keyboard click', () => {
    render();
    click('retry');
    click('text', null);
    expect(document.activeElement).not.toBe(textarea());
  });

  it('keeps a text selection', () => {
    render();
    window.getSelection()!.selectAllChildren(container.querySelector('#text')!);
    click('text');
    expect(document.activeElement).not.toBe(textarea());
  });

  it('does nothing while the composer is disabled', () => {
    render(false);
    click('text');
    expect(document.activeElement).not.toBe(textarea());
  });
});
