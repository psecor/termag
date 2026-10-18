import { describe, it, expect, vi } from 'vitest';
vi.mock('../../db', () => ({ prisma: {} }));
import { createRequire } from 'module';
import path from 'path';
import { parseInventoryReply, changedEntries, entriesToWrite, AGENT_COMPONENTS, ORCHESTRATOR_COMPONENTS } from './store';

const e = (name: string, version: string | null, ok = version !== null) => ({ name, ok, version, raw: version, path: ok ? `/bin/${name}` : null });

describe('parseInventoryReply', () => {
  it('keeps well-formed entries and clips long fields', () => {
    const r = parseInventoryReply({ entries: [e('claude', '2.1.300'), { name: 'git', ok: true, version: 'v'.repeat(100), raw: null, path: null }], agentCommit: 'a'.repeat(40), checkoutCommit: 'nope' });
    expect(r?.entries[0]).toEqual(e('claude', '2.1.300'));
    expect(r?.entries[1].version).toHaveLength(60);
    expect(r?.agentCommit).toBe('a'.repeat(40));
    expect(r?.checkoutCommit).toBeNull();
  });
  it('keeps only the agent\'s own components: never termag, image, hooks or orchestrator-only rows', () => {
    const r = parseInventoryReply({ entries: [{ name: 'Bad Name', ok: true }, e('termag', 'x'), e('image', 'x'), e('hooks', 'current'), e('nginx', '1.24.0'), e('git', '2.43.0')] });
    expect(r?.entries.map(x => x.name)).toEqual(['git']);
    expect(parseInventoryReply({ entries: [e('nginx', '1.24.0')] }, ORCHESTRATOR_COMPONENTS)?.entries.map(x => x.name)).toEqual(['nginx']);
  });
  it('matches the agent\'s probe list (agent/software-inventory.js)', () => {
    const req = createRequire(__filename);
    const agent = req(path.resolve(__dirname, '../../../../agent/software-inventory.js')) as { PROBES: Array<{ name: string }>; ORCHESTRATOR_PROBES: Array<{ name: string }> };
    expect([...AGENT_COMPONENTS].sort()).toEqual([...agent.PROBES.map(p => p.name), 'os', 'kernel'].sort());
    expect([...ORCHESTRATOR_COMPONENTS].sort()).toEqual([...AGENT_COMPONENTS, ...agent.ORCHESTRATOR_PROBES.map(p => p.name)].sort());
  });
  it('rejects a reply that is not an inventory', () => {
    expect(parseInventoryReply(null)).toBeNull();
    expect(parseInventoryReply({ entries: 'no' })).toBeNull();
  });
});

describe('changedEntries', () => {
  it('records first sightings, upgrades and removals, and ignores repeats', () => {
    const prev = new Map<string, string | null>([['claude', '2.1.290'], ['git', '2.43.0'], ['docker', '29.8.1']]);
    expect(changedEntries(prev, [e('claude', '2.1.300'), e('git', '2.43.0'), e('docker', null), e('pi', '1.0.2'), e('codex', null)])).toEqual([
      { component: 'claude', from: '2.1.290', to: '2.1.300' },
      { component: 'docker', from: '29.8.1', to: null },
      { component: 'pi', from: null, to: '1.0.2' },
    ]);
  });
});

describe('transient probe failures', () => {
  const flaky = { name: 'claude', ok: false, version: null, raw: 'Error: timed out', path: '/bin/claude' };
  it('keep the last good row and write no change', () => {
    const prev = new Map<string, string | null>([['claude', '2.1.300']]);
    expect(entriesToWrite(prev, [flaky])).toEqual([]);
    expect(changedEntries(prev, [flaky])).toEqual([]);
  });
  it('are written as unknown when there is no row yet, still with no change', () => {
    expect(entriesToWrite(new Map(), [flaky])).toEqual([flaky]);
    expect(changedEntries(new Map(), [flaky])).toEqual([]);
  });
  it('a real uninstall (no path) is still a change', () => {
    const gone = { name: 'claude', ok: false, version: null, raw: null, path: null };
    expect(changedEntries(new Map([['claude', '2.1.300']]), [gone])).toEqual([{ component: 'claude', from: '2.1.300', to: null }]);
  });
});
