// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));

import SignIn, { signInError } from './SignIn';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null; host = null;
});

function render(search: string, label = 'Sign in with Google') {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<MemoryRouter initialEntries={[`/login${search}`]}><SignIn label={label} /></MemoryRouter>));
  return host;
}

describe('the redrawn sign-in page', () => {
  it('names the provider and links to the backend\'s sign-in', () => {
    const el = render('');
    const link = el.querySelector('a');
    expect(link?.textContent).toBe('Sign in with Google');
    expect(link?.getAttribute('href')).toBe('/termag/auth/login');
    expect(el.querySelector('[role="alert"], .wel-login-alert')).toBeNull();
  });

  it('says why a sign-in was refused', () => {
    const el = render('?error=unauthorized');
    expect(el.textContent).toContain("This account doesn't have access to termag yet.");
  });

  it('says when the sign-in timed out', () => {
    expect(render('?error=session_expired').textContent).toContain('Sign-in took too long and timed out.');
  });

  it('shows nothing for an error it does not know', () => {
    expect(signInError('?error=something_else')).toBeNull();
    expect(signInError('')).toBeNull();
  });
});
