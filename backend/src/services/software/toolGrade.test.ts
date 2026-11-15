import { describe, it, expect } from 'vitest';
import { TOOL_REGISTRY, type ToolComponent } from '../toolUpdate/components';
import { DEFAULT_CLAUDE_UPDATE_POLICY } from '../claudeUpdatePolicy';
import { CURSOR_PINNED_LATEST } from '../cursorUpdatePolicy';
import { PI_PINNED_LATEST } from '../piUpdatePolicy';
import { hostRefusal, selectFleet, type HostFacts } from '../toolUpdate/fleet';
import { cellPolicy, policyReferenceText, policyToolState, unownedToolState, type PolicyInput } from './toolGrade';

const on = (v: string) => ({ version: v, ok: true });
const auto = (floor: string, target = 'latest'): PolicyInput => ({ mode: 'auto', floor, target });

describe('policyToolState: each state', () => {
  const tool = TOOL_REGISTRY.claude;
  const fleet = ['2.1.300', '2.1.314', '2.1.320'];
  const pinned = cellPolicy(auto('2.1.308', '2.1.314'), fleet, tool);
  it('grades against an exact target, never the fleet\'s newest', () => {
    expect(pinned.reference).toBe('2.1.314');
    expect(policyToolState(on('2.1.314'), pinned)).toBe('current');
    expect(policyToolState(on('2.1.310'), pinned)).toBe('behind');
    expect(policyToolState(on('2.1.320'), pinned)).toBe('ahead');
  });
  it('is below-floor under the floor, whatever the mode', () => {
    expect(policyToolState(on('2.1.240'), pinned)).toBe('below-floor');
    expect(policyToolState(on('2.1.307'), { ...pinned, mode: 'off' })).toBe('below-floor');
    expect(policyToolState(on('2.1.308'), pinned)).toBe('behind');
  });
  it('is held behind the target with the mode off, and current or ahead as with it on', () => {
    const off = { ...pinned, mode: 'off' as const };
    expect(policyToolState(on('2.1.310'), off)).toBe('held');
    expect(policyToolState(on('2.1.314'), off)).toBe('current');
    expect(policyToolState(on('2.1.320'), off)).toBe('ahead');
    expect(policyToolState(on('2.1.310'), { ...pinned, mode: 'manual' })).toBe('behind');
  });
  it('under latest, takes the newest version on the boxes', () => {
    const latest = cellPolicy(auto('2.1.308'), fleet, tool);
    expect(latest.reference).toBe('2.1.320');
    expect(policyToolState(on('2.1.320'), latest)).toBe('current');
    expect(policyToolState(on('2.1.314'), latest)).toBe('behind');
  });
  it('keeps missing and unknown', () => {
    expect(policyToolState({ version: null, ok: false, path: null }, pinned)).toBe('missing');
    expect(policyToolState({ version: null, ok: false, path: '/usr/bin/claude' }, pinned)).toBe('unknown');
    expect(policyToolState(null, pinned)).toBe('unknown');
    expect(policyToolState(on('beta'), pinned)).toBe('unknown');
    expect(policyToolState(on('2.1.314'), { ...pinned, reference: null })).toBe('unknown');
  });
});

describe('policyToolState: per tool, at its own default floor', () => {
  // A version below each tool's code-default floor, one on it, and the reference's own.
  const below: Record<ToolComponent, string> = {
    claude: '2.1.300', codex: '0.130.9', cursor: '2025.09.16-aaaaaaa', devin: '3000.11.91', pi: '0.78.0',
    gh: '2.101.0', aws: '2.35.2', node: '24.21.0', python: '3.13.17', docker: '29.9.2',
  };
  const floors: Record<ToolComponent, string> = {
    claude: DEFAULT_CLAUDE_UPDATE_POLICY.floor, codex: '0.131.0', cursor: '2025.09.17-25b418f', devin: '3000.11.92', pi: '0.79.0',
    gh: '2.102.0', aws: '2.35.3', node: '24.22.1', python: '3.13.18', docker: '29.9.3',
  };
  for (const c of Object.keys(below) as ToolComponent[]) {
    it(c, () => {
      const tool = TOOL_REGISTRY[c];
      const p = cellPolicy(auto(floors[c]), [floors[c], below[c]], tool);
      expect(policyToolState(on(below[c]), p)).toBe('below-floor');
      // Under latest: a pinned latest (Cursor, pi) is the reference; otherwise the boxes' newest, here the floor's version.
      const ref = c === 'cursor' ? CURSOR_PINNED_LATEST : c === 'pi' ? PI_PINNED_LATEST : floors[c];
      expect(p.reference).toBe(ref);
      expect(policyToolState(on(ref), p)).toBe('current');
      if (ref !== floors[c]) expect(policyToolState(on(floors[c]), p)).toBe('behind');
    });
  }
  it('Node: a raised floor makes every box under it below-floor at once', () => {
    const p = cellPolicy(auto('24.23.0'), ['24.22.1', '24.23.0'], TOOL_REGISTRY.node);
    expect(policyToolState(on('24.22.1'), p)).toBe('below-floor');
    expect(policyToolState(on('24.23.0'), p)).toBe('current');
  });
});

describe('the Cursor agent\'s dated builds against a policy', () => {
  const tool = TOOL_REGISTRY.cursor;
  it('latest is the pinned build: another build of its day is behind, a later one ahead', () => {
    const p = cellPolicy(auto('2025.09.17-25b418f'), ['2026.10.22-9abcdef'], tool);
    expect(p.reference).toBe(CURSOR_PINNED_LATEST);
    expect(policyToolState(on(CURSOR_PINNED_LATEST), p)).toBe('current');
    expect(policyToolState(on('2026.10.22-9abcdef'), p)).toBe('behind');
    // Past the pin, whatever it is (it moves with each bump).
    expect(policyToolState(on('2099.01.01-0000000'), p)).toBe('ahead');
  });
  it('another build of the floor\'s day is not below it, as on the box', () => {
    const p = cellPolicy(auto('2025.09.17-25b418f'), [], tool);
    expect(policyToolState(on('2025.09.17-ffffff0'), p)).toBe('behind');
    expect(policyToolState(on('2025.09.16-25b418f'), p)).toBe('below-floor');
  });
});

describe('the cells agree with the fleet update', () => {
  // selectFleet's scope takes exactly the boxes the matrix grades below-floor (below-floor) or below-floor and behind (behind).
  it('for each scope', () => {
    const tool = TOOL_REGISTRY.claude;
    const versions = ['2.1.240', '2.1.300', '2.1.310', '2.1.314', '2.1.320'];
    const p = cellPolicy(auto('2.1.308', '2.1.314'), versions, tool);
    const facts: HostFacts[] = versions.map((v, i) => ({ hostKey: `i-${i}`, connected: true, capable: true, enabled: true, inFlight: false, version: v, floor: p.floor, reference: p.reference }));
    const states = new Map(versions.map((v, i) => [`i-${i}`, policyToolState(on(v), p)]));
    expect(selectFleet(facts, 'below-floor').hosts).toEqual([...states].filter(([, s]) => s === 'below-floor').map(([k]) => k));
    expect(selectFleet(facts, 'behind').hosts).toEqual([...states].filter(([, s]) => s === 'below-floor' || s === 'behind').map(([k]) => k));
  });
});

describe('a box below its floor with the mode off', () => {
  // The cell stays below-floor, and the fleet update skips it (hostRefusal): the matrix's refusal says so,
  // and the tab leaves it out of "Update below floor (N)" (frontend utils/toolUpdate.ts scopeCount).
  it('is below-floor, and selectFleet skips it as updates off', () => {
    const p = cellPolicy({ mode: 'off', floor: '2.1.308', target: 'latest' }, ['2.1.240', '2.1.314'], TOOL_REGISTRY.claude);
    expect(policyToolState(on('2.1.240'), p)).toBe('below-floor');
    const fact: HostFacts = { hostKey: 'i-0', connected: true, capable: true, enabled: false, inFlight: false, version: '2.1.240', floor: p.floor, reference: p.reference };
    expect(hostRefusal(fact)).toBe('claude_update_off');
    expect(selectFleet([fact], 'below-floor')).toEqual({ hosts: [], skipped: [{ hostKey: 'i-0', reason: 'claude_update_off' }] });
  });
});

describe('unowned boxes and the summary', () => {
  it('an unowned (warm pool) box older than the fleet is held, not behind', () => {
    expect(unownedToolState(on('2.1.300'), '2.1.314')).toBe('held');
    expect(unownedToolState(on('2.0.1'), '2.1.314')).toBe('held');
    expect(unownedToolState(on('2.1.314'), '2.1.314')).toBe('current');
    expect(unownedToolState({ version: null, ok: false, path: null }, '2.1.314')).toBe('missing');
  });
  it('names the one reference every box shares, else each, most common first', () => {
    expect(policyReferenceText(['1.5.0', '1.5.0', null])).toBe('1.5.0');
    expect(policyReferenceText(['2.1.314', '2.1.320', '2.1.314'])).toBe('2.1.314 · 2.1.320');
    expect(policyReferenceText([])).toBeNull();
  });
});
