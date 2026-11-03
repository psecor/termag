// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReadOnlyTurnNotice } from './ReadOnlyTurnNotice';

vi.mock('../../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
function show(el: React.ReactElement): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
}
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });

describe('ReadOnlyTurnNotice', () => {
  it('says the turn is read-only, why, and the fix, with only the commands as code', () => {
    const el = show(
      <ReadOnlyTurnNotice
        reason="the checkout has an origin but branch vk/x tracks none of its branches"
        fix="give branch vk/x an upstream on origin: push it with `git push -u origin vk/x`, or `git branch --set-upstream-to=origin/<base> vk/x`"
      />,
    );
    const status = el.querySelector('[role="alert"]')!;
    expect(status.textContent).toContain('This turn is read-only');
    expect(status.textContent).toContain('because the checkout has an origin but branch vk/x tracks none of its branches.');
    expect([...el.querySelectorAll('code')].map(c => c.textContent)).toEqual(['git push -u origin vk/x', 'git branch --set-upstream-to=origin/<base> vk/x']);
    expect(el.querySelector('.lp-theme')).not.toBeNull();
  });

  it('says a refusal with no fix is on purpose', () => {
    const el = show(<ReadOnlyTurnNotice reason="branch main was checked out from a pull request" />);
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('That is on purpose for this checkout');
  });
});
