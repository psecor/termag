import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SIDEBAR_VIEW } from '../../chat/sidebarView';
import type { PaletteAction } from '../../utils/searchPalette';
import { DOCS_SITE_URL } from '../settings/settingsDocs';
import { chatCommands, type ChatCommandInput } from './chatCommands';

const input = (over: Partial<ChatCommandInput> = {}): ChatCommandInput => ({
  navigate: vi.fn(), openLab: vi.fn(), newSessionKeys: '⌘⇧O', panel: null, tools: [], view: null, setView: vi.fn(), screen: [], ...over,
});
const ids = (actions: PaletteAction[]) => actions.map(a => a.id);
const byId = (actions: PaletteAction[], id: string) => actions.find(a => a.id === id)!;

describe('chatCommands', () => {
  it('with nothing open: New session, Open Lab, How it works and Settings, each suggested', () => {
    const out = chatCommands(input());
    expect(ids(out)).toEqual(['new-session', 'open-lab', 'docs', 'settings']);
    expect(out.every(a => a.suggested)).toBe(true);
    expect(byId(out, 'new-session').keys).toBe('⌘⇧O');
  });

  it('runs each where it goes', () => {
    const c = input();
    const out = chatCommands(c);
    byId(out, 'new-session').run();
    byId(out, 'settings').run();
    byId(out, 'open-lab').run();
    const open = vi.fn();
    vi.stubGlobal('open', open);
    byId(out, 'docs').run();
    expect(c.navigate).toHaveBeenNthCalledWith(1, '/chat/new');
    expect(c.navigate).toHaveBeenNthCalledWith(2, '/settings?from=chat');
    expect(c.openLab).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(DOCS_SITE_URL, '_blank', 'noopener,noreferrer');
    vi.unstubAllGlobals();
  });

  it('with PR reviews on, offers Review a pull request…, suggested, after Open Lab, and it opens the Reviews page', () => {
    const c = input({ reviews: true });
    const out = chatCommands(c);
    expect(ids(out)).toEqual(['new-session', 'open-lab', 'review-pr', 'docs', 'settings']);
    expect(byId(out, 'review-pr')).toMatchObject({ label: 'Review a pull request…', suggested: true });
    byId(out, 'review-pr').run();
    expect(c.navigate).toHaveBeenCalledWith('/chat/reviews');
    expect(ids(chatCommands(input({ reviews: false })))).not.toContain('review-pr');
  });

  it("puts the open chat's own after New session, and its Open in Lab replaces Open Lab", () => {
    const screen: PaletteAction[] = [
      { id: 'open-in-lab', label: 'Open in Lab', run: () => {} },
      { id: 'archive', label: 'Archive session', run: () => {} },
    ];
    expect(ids(chatCommands(input({ screen })))).toEqual(['new-session', 'open-in-lab', 'archive', 'docs', 'settings']);
  });

  it('the panel: Show or Hide tools by its state, then each tool it offers beside the session', () => {
    const show = vi.fn();
    const toggle = vi.fn();
    const closed = chatCommands(input({ panel: { open: false, toggle, show }, tools: ['files', 'terminal', 'pr'] }));
    expect(ids(closed)).toEqual(['new-session', 'open-lab', 'tools', 'tool:files', 'tool:terminal', 'tool:pr', 'docs', 'settings']);
    expect(byId(closed, 'tools')).toMatchObject({ label: 'Show tools', keys: '⌃⌥B', suggested: true });
    expect(byId(closed, 'tool:pr').label).toBe('Pull request');
    byId(closed, 'tool:terminal').run();
    expect(show).toHaveBeenCalledWith('terminal');
    byId(closed, 'tools').run();
    expect(toggle).toHaveBeenCalled();
    expect(byId(chatCommands(input({ panel: { open: true, toggle, show } })), 'tools').label).toBe('Hide tools');
  });

  it("lists no tools where the panel can't show one", () => {
    expect(ids(chatCommands(input({ panel: { open: false, toggle: () => {} }, tools: ['terminal'] })))).not.toContain('tool:terminal');
  });

  it('under the sidebar redesign, one list: no Show, Group by orders it, and Sort offers the other order', () => {
    const setView = vi.fn();
    const out = chatCommands(input({ view: { ...DEFAULT_SIDEBAR_VIEW, show: 'projects', groupBy: 'project' }, redesign: true, setView }));
    expect(out.filter(a => a.id.startsWith('view:')).map(a => a.label)).toEqual([
      'Standard rows', 'Group by space', 'Group by status', 'Sort by recent activity', 'Hide files and new tabs', "Hide sessions that aren't running",
    ]);
    byId(out, 'view:sort-recent').run();
    expect(setView).toHaveBeenLastCalledWith({ sort: 'recent' });
    const recent = chatCommands(input({ view: { ...DEFAULT_SIDEBAR_VIEW, show: 'projects', sort: 'recent' }, redesign: true, setView }));
    expect(recent.map(a => a.label)).toContain('Sort by created');
    expect(recent.map(a => a.label)).not.toContain('Sort by recent activity');
    byId(recent, 'view:sort-created').run();
    expect(setView).toHaveBeenLastCalledWith({ sort: 'created' });
  });

  it("the sidebar's view options, each offering the other choice", () => {
    const setView = vi.fn();
    const out = chatCommands(input({ view: DEFAULT_SIDEBAR_VIEW, setView }));
    expect(out.filter(a => a.id.startsWith('view:')).map(a => a.label)).toEqual([
      'Show every session', 'Standard rows', 'Group by project', 'Group by status', 'Hide files and new tabs', "Hide sessions that aren't running",
    ]);
    byId(out, 'view:by-project').run();
    expect(setView).toHaveBeenLastCalledWith({ groupBy: 'project' });
    setView.mockClear();
    byId(out, 'view:standard').run();
    byId(out, 'view:idle').run();
    expect(setView).toHaveBeenNthCalledWith(1, { density: 'standard' });
    expect(setView).toHaveBeenNthCalledWith(2, { showIdle: false });
    const flipped = chatCommands(input({ view: { show: 'tabs', density: 'standard', groupBy: 'status', showFiles: false, showIdle: false, olderDays: 3, sort: 'created' } }));
    expect(flipped.filter(a => a.id.startsWith('view:')).map(a => a.label)).toEqual([
      'Show every session', 'Compact rows', 'Group by space', 'Group by project', 'Show files and new tabs', "Show sessions that aren't running",
    ]);
    // Projects groups by itself: no Group by, and the way back to the tabs.
    const projects = chatCommands(input({ view: { ...DEFAULT_SIDEBAR_VIEW, show: 'projects' }, setView }));
    expect(projects.filter(a => a.id.startsWith('view:')).map(a => a.label)).toEqual([
      'Show tabs', 'Standard rows', 'Hide files and new tabs', "Hide sessions that aren't running",
    ]);
    setView.mockClear();
    byId(projects, 'view:tabs').run();
    expect(setView).toHaveBeenLastCalledWith({ show: 'tabs' });
    const byProject = chatCommands(input({ view: { ...DEFAULT_SIDEBAR_VIEW, groupBy: 'project' } }));
    expect(byProject.filter(a => a.id.startsWith('view:by-')).map(a => a.label)).toEqual(['Group by space', 'Group by status']);
    expect(flipped.some(a => a.id.startsWith('view:') && a.suggested)).toBe(false);
  });

});
