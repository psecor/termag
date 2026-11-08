import { describe, expect, it } from 'vitest';
import { CHAT_HOME_HREF, offersPhoneView, openInChatHref, opensInChat, phoneViewHref, showsAsChat, subscribePhoneView } from './chatLinks';
import { isSdkChat } from '../chat/simpleChat';
import { MOBILE_MEDIA_QUERY, TOUCH_MEDIA_QUERY } from './redirect';

const media = (matching: string[]) => (q: string) => ({ matches: matching.includes(q) });

describe('the way between /m and /chat', () => {
  it('opens the simple UI at its home', () => {
    expect(CHAT_HOME_HREF).toBe('/chat');
  });

  it("opens one session at its chat URL, carrying a workstream other than main", () => {
    expect(openInChatHref({ projectId: 'p1', workstream: 'main' })).toBe('/chat/p/p1');
    expect(openInChatHref({ projectId: 'p 1', workstream: 'feat/x' })).toBe('/chat/p/p%201?ws=feat%2Fx');
  });

  it('offers Open in Chat only for sessions the simple UI lists', () => {
    expect(opensInChat({ kind: 'normal', workstream: 'main' })).toBe(true);
    expect(opensInChat({ kind: 'normal', workstream: 'feat/x' })).toBe(true);
    expect(opensInChat({ workstream: 'main' })).toBe(true);
    // An automation's runs are chats; its main never runs an agent.
    expect(opensInChat({ kind: 'automation', workstream: 'run-20261105-1900' })).toBe(true);
    expect(opensInChat({ kind: 'automation', workstream: 'main' })).toBe(false);
    expect(opensInChat({ kind: 'metaterm', workstream: 'main' })).toBe(false);
    expect(opensInChat({ kind: 'cloud', workstream: 'main' })).toBe(false);
  });

  it('treats a session as a chat only when the simple UI lists it and its agent is a chat runner', () => {
    const workstreams = [{ id: 'w-main', name: 'main' }, { id: 'w-run', name: 'run-1' }] as never;
    const wf = (workstreamId: string, provider: string) => ({ id: workstreamId, type: 'agent', provider, server: '', projectId: 'p', workstreamId });
    // The automation's main has no agent; chatProvider falls back to the run's chat runner.
    const automation = { kind: 'automation', workstreams, workflows: [wf('w-run', 'claude-chat')] } as never;
    expect(showsAsChat(automation, 'run-1')).toBe(true);
    expect(showsAsChat(automation, 'main')).toBe(false);
    // ...but its main still has no agent pane: the phone client keys the pane off isSdkChat.
    expect(isSdkChat(automation, 'main')).toBe(true);
    const normal = { kind: 'normal', workstreams, workflows: [wf('w-main', 'claude-chat')] } as never;
    expect(showsAsChat(normal, 'main')).toBe(true);
    expect(showsAsChat(normal, 'run-1')).toBe(true);
    const pane = { kind: 'normal', workstreams, workflows: [wf('w-main', 'claude')] } as never;
    expect(showsAsChat(pane, 'main')).toBe(false);
    const metaterm = { kind: 'metaterm', workstreams, workflows: [wf('w-main', 'claude-chat')] } as never;
    expect(showsAsChat(metaterm, 'main')).toBe(false);
  });

  it('comes back to the same conversation in the phone client, or its home', () => {
    expect(phoneViewHref(null)).toBe('/m');
    expect(phoneViewHref('p1')).toBe('/m/p/p1');
    expect(phoneViewHref('p1', 'feat/x')).toBe('/m/p/p1?ws=feat%2Fx');
  });

  it('offers Phone view where the workspace would send the browser to /m', () => {
    expect(offersPhoneView({ matchMedia: media([MOBILE_MEDIA_QUERY]) })).toBe(true);
    // Installed on a touch device, whatever the width.
    expect(offersPhoneView({ matchMedia: media(['(display-mode: standalone)', TOUCH_MEDIA_QUERY]) })).toBe(true);
    // A narrow desktop window, or a desktop install, is not a phone.
    expect(offersPhoneView({ matchMedia: media([]) })).toBe(false);
    expect(offersPhoneView({ matchMedia: media(['(display-mode: standalone)']) })).toBe(false);
    expect(offersPhoneView(undefined)).toBe(false);
    expect(offersPhoneView({ matchMedia: () => { throw new Error('no'); } })).toBe(false);
  });

  it('re-reads Phone view when the phone rotates, and stops listening once unsubscribed', () => {
    // A phone: coarse pointer always; the width query matches only in portrait.
    let portrait = false;
    const listeners = new Map<string, Set<() => void>>();
    const matchMedia = (q: string) => ({
      get matches() { return q === TOUCH_MEDIA_QUERY || (q === MOBILE_MEDIA_QUERY && portrait); },
      addEventListener: (_: 'change', cb: () => void) => { (listeners.get(q) ?? listeners.set(q, new Set()).get(q)!).add(cb); },
      removeEventListener: (_: 'change', cb: () => void) => { listeners.get(q)?.delete(cb); },
    });
    const env = { matchMedia };
    const seen: boolean[] = [];
    const unsubscribe = subscribePhoneView(env, () => seen.push(offersPhoneView(env)));
    expect(offersPhoneView(env)).toBe(false);
    portrait = true;
    listeners.get(MOBILE_MEDIA_QUERY)!.forEach(cb => cb());
    expect(seen).toEqual([true]);
    unsubscribe();
    expect([...listeners.values()].every(set => set.size === 0)).toBe(true);
    expect(subscribePhoneView(undefined, () => {})).toBeTypeOf('function');
  });
});
