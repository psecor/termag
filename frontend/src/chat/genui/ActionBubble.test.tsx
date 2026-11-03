// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActionBubble } from './ActionBubble';

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('ActionBubble', () => {
  it('reads as what was done, with everything the agent got one click away', () => {
    act(() => root.render(<ActionBubble payload={{ action: 'approve', surfaceId: 'ui-1', sourceComponentId: 'ok', comment: 'Ship it', context: { comment: 'Ship it', env: 'prod' } }} />));
    expect(host.querySelector('.genui-action-summary')?.textContent).toBe('Approved: “Ship it”');
    const details = host.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(JSON.parse(details.querySelector('pre')!.textContent!)).toEqual({ action: 'approve', sourceComponentId: 'ok', comment: 'Ship it', context: { comment: 'Ship it', env: 'prod' } });
  });
});
