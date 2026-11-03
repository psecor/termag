import { beforeEach, describe, expect, it, vi } from 'vitest';

const recorded: Array<{ name: string; attributes: unknown }> = [];
vi.mock('./observability', () => ({
  recordProductEvent: (name: string, attributes: unknown) => { recorded.push({ name, attributes }); },
}));

const {
  chatCommandName, clientOpenedAttributes, clientView, recordChatAction, recordTypedChatCommand, REOPEN_AFTER_MS, shouldRecordOpened,
} = await import('./usageEvents');

beforeEach(() => { recorded.length = 0; });

describe('clientView', () => {
  it('tells the phone client, the simple UI, the workspace and the other pages apart', () => {
    expect(clientView('/m')).toBe('mobile');
    expect(clientView('/m/p/abc')).toBe('mobile');
    expect(clientView('/chat')).toBe('simple');
    expect(clientView('/chat/p/abc/main')).toBe('simple');
    expect(clientView('/')).toBe('full');
    expect(clientView('/settings')).toBe('full');
    expect(clientView('/automations')).toBe('other');
    expect(clientView('/admin/bugs')).toBe('other');
    expect(clientView('/mobile-ish')).toBe('full');
  });
});

describe('clientOpenedAttributes', () => {
  it('carries the view, mode, installed app, phone, touch and notifications, and nothing else', () => {
    expect(clientOpenedAttributes({
      pathname: '/m', standalone: true, phone: true, touch: true, notifications: 'granted', uiMode: 'simple', resumed: false,
    })).toEqual({
      'termag.view': 'mobile', 'termag.uiMode': 'simple', 'termag.standalone': true, 'termag.phone': true,
      'termag.touch': true, 'termag.notifications': 'granted', 'termag.resumed': false,
    });
  });
});

describe('shouldRecordOpened', () => {
  it('records the first open from the mount, and a reopen only after the page has been away long enough', () => {
    expect(shouldRecordOpened(null, 0, false)).toBe(true);
    expect(shouldRecordOpened(0, REOPEN_AFTER_MS * 2, false)).toBe(false);
    expect(shouldRecordOpened(null, 0, true)).toBe(false);
    expect(shouldRecordOpened(0, REOPEN_AFTER_MS - 1, true)).toBe(false);
    expect(shouldRecordOpened(0, REOPEN_AFTER_MS, true)).toBe(true);
  });
});

describe('chatCommandName', () => {
  it('names Claude Code built-ins and termag skills', () => {
    expect(chatCommandName('/clear')).toBe('clear');
    expect(chatCommandName('  /Model opus ')).toBe('model');
    expect(chatCommandName('/termag-pr')).toBe('termag-pr');
    expect(chatCommandName('/code-review high 123')).toBe('code-review');
  });

  it('calls every other command custom, so its name never leaves the browser', () => {
    expect(chatCommandName('/acme-launch-plan')).toBe('custom');
    expect(chatCommandName('/myplugin:deploy prod')).toBe('custom');
  });

  it('is null for anything that is not a slash command, a pasted path included', () => {
    for (const text of ['clear', 'please /clear', '/etc/hosts is broken', '/', '/ space', '']) expect(chatCommandName(text)).toBeNull();
  });
});

describe('recording', () => {
  it('records a typed command with where it was typed, and nothing for a message', () => {
    recordTypedChatCommand('/compact keep the plan', 'pane');
    recordTypedChatCommand('fix the build', 'sdk');
    expect(recorded).toEqual([{ name: 'chat.command', attributes: { 'termag.command': 'compact', 'termag.via': 'typed', 'termag.chat': 'pane' } }]);
  });

  it('records a context action as a button', () => {
    recordChatAction('resume');
    expect(recorded).toEqual([{ name: 'chat.command', attributes: { 'termag.command': 'resume', 'termag.via': 'button', 'termag.chat': 'sdk' } }]);
  });
});
