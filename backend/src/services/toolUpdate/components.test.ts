import { describe, expect, it, vi } from 'vitest';
import { boolVariation, jsonVariation } from '../featureFlags';
import { PROVIDERS } from '../../providers/registry';
import { TOOL_COMPONENTS, TOOL_REGISTRY, isToolComponent, toolDescriptor } from './components';
import { TOOL_UPDATE_CAPABILITY } from './run';

// boolVariation is there only to show it is never called: no tool reads an on/off flag.
vi.mock('../featureFlags', () => ({ boolVariation: vi.fn(async () => true), jsonVariation: vi.fn(async () => ({ floor: '2.1.400', target: 'nope' })) }));

const ada = { id: 'u1', unixUsername: 'ada', googleEmail: 'ada@example.test', displayName: 'Ada', defaultAgentProvider: 'claude' };
const box = { id: 'box-a', name: 'a', kind: 'ec2' };

describe('the tool registry', () => {
  it('lists Claude Code, Codex, the Cursor agent and the Devin CLI, keyed by their component', () => {
    expect(TOOL_COMPONENTS).toEqual(['claude', 'codex', 'cursor', 'devin', 'pi', 'gh', 'aws', 'node', 'python', 'docker']);
    expect(TOOL_REGISTRY.docker).toMatchObject({ displayName: 'Docker', inventoryName: 'docker', providers: [], runnerFloor: false, capability: 'tool-update-docker-v1', atStart: true });
    expect(TOOL_REGISTRY.python).toMatchObject({ displayName: 'Python', inventoryName: 'python', providers: [], runnerFloor: false, capability: 'tool-update-python-v1' });
    expect(TOOL_REGISTRY.python.isVersion('3.13.18')).toBe(true);
    expect(TOOL_REGISTRY.python.isVersion('3.13')).toBe(false);
    expect(TOOL_REGISTRY.node).toMatchObject({ displayName: 'Node', inventoryName: 'node', providers: ['claude', 'codex', 'pi'], runnerFloor: false, capability: 'tool-update-node-v1' });
    expect(TOOL_REGISTRY.aws).toMatchObject({ displayName: 'AWS CLI', inventoryName: 'aws', providers: [], runnerFloor: false, capability: 'tool-update-aws-v1' });
    expect(TOOL_REGISTRY.aws.isVersion('2.39.2')).toBe(true);
    expect(TOOL_REGISTRY.gh).toMatchObject({ displayName: 'GitHub CLI', inventoryName: 'gh', providers: [], runnerFloor: false, capability: 'tool-update-gh-v1' });
    expect(TOOL_REGISTRY.gh.isVersion('2.103.3')).toBe(true);
    expect(TOOL_REGISTRY.gh.isVersion('2.45.0-1ubuntu0.3')).toBe(false);
    expect(TOOL_REGISTRY.pi).toMatchObject({ displayName: 'pi', inventoryName: 'pi', providers: ['pi'], runnerFloor: false, capability: 'tool-update-pi-v1' });
    expect(TOOL_REGISTRY.devin).toMatchObject({ displayName: 'Devin CLI', inventoryName: 'devin', providers: ['devin'], runnerFloor: false, capability: 'tool-update-devin-v1' });
    expect(TOOL_REGISTRY.devin.isVersion('3000.11.234')).toBe(true);
    expect(TOOL_REGISTRY.cursor).toMatchObject({ displayName: 'Cursor agent', inventoryName: 'cursor-agent', providers: ['cursor'], runnerFloor: false, capability: 'tool-update-cursor-v1' });
    expect(TOOL_REGISTRY.cursor.isVersion('2026.10.22-27dcf5f')).toBe(true);
    expect(TOOL_REGISTRY.cursor.isVersion('2.1.308')).toBe(false);
    expect(TOOL_REGISTRY.codex.isVersion('0.166.0')).toBe(true);
    for (const c of TOOL_COMPONENTS) expect(TOOL_REGISTRY[c].component).toBe(c);
    expect(TOOL_REGISTRY.claude).toMatchObject({ inventoryName: 'claude', providers: ['claude'], runnerFloor: true, capability: TOOL_UPDATE_CAPABILITY });
    expect(TOOL_REGISTRY.codex).toMatchObject({ displayName: 'Codex', inventoryName: 'codex', providers: ['codex'], runnerFloor: false, capability: 'tool-update-codex-v1' });
  });

  it('gives each tool its own capability, so an agent without its unit is never sent its run', () => {
    expect(new Set(TOOL_COMPONENTS.map(c => TOOL_REGISTRY[c].capability)).size).toBe(TOOL_COMPONENTS.length);
  });

  it('names only providers the provider registry has, each with a way to resume', () => {
    for (const c of TOOL_COMPONENTS) for (const p of TOOL_REGISTRY[c].providers) expect(PROVIDERS[p]?.resumeCommand || PROVIDERS[p]?.resumeById).toBeTruthy();
  });

  it('resumes a Cursor chat only by a chat id, never by anything a shell would read', () => {
    const byId = PROVIDERS.cursor.resumeById!;
    expect(byId('3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b')).toBe('cursor-agent --resume 3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b');
    for (const bad of ['', 'latest', '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b; rm -rf ~', '--continue']) expect(byId(bad)).toBeNull();
    expect(PROVIDERS.cursor.resumeCommand).toBeUndefined();
  });

  it('resumes a Devin session only by a session id; reconnect keeps launching it fresh', () => {
    const byId = PROVIDERS.devin.resumeById!;
    expect(byId('9c1e2f3a-4b5c-4d6e-8f70-123456789abc')).toBe('devin --resume 9c1e2f3a-4b5c-4d6e-8f70-123456789abc');
    for (const bad of ['', 'short', '9c1e2f3a; rm -rf ~', '--continue', 'a b c d e f g h']) expect(byId(bad)).toBeNull();
    expect(PROVIDERS.devin.resumeCommand).toBeUndefined();
  });

  it('looks a component up, and nothing else', () => {
    expect(toolDescriptor('claude')).toBe(TOOL_REGISTRY.claude);
    expect(toolDescriptor('codex')).toBe(TOOL_REGISTRY.codex);
    expect(toolDescriptor('cursor')).toBe(TOOL_REGISTRY.cursor);
    expect(toolDescriptor('devin')).toBe(TOOL_REGISTRY.devin);
    expect(toolDescriptor('pi')).toBe(TOOL_REGISTRY.pi);
    expect(toolDescriptor('gh')).toBe(TOOL_REGISTRY.gh);
    expect(toolDescriptor('aws')).toBe(TOOL_REGISTRY.aws);
    expect(toolDescriptor('node')).toBe(TOOL_REGISTRY.node);
    expect(toolDescriptor('python')).toBe(TOOL_REGISTRY.python);
    for (const c of ['cursor-agent', 'rust', 'Codex', '', null, undefined, 'constructor', '__proto__']) {
      expect(toolDescriptor(c)).toBeNull();
      expect(isToolComponent(c)).toBe(false);
    }
  });

  it('reads Claude Code\'s policy for the owner and the box, and its mode decides', async () => {
    expect(await TOOL_REGISTRY.claude.policy(ada, box)).toMatchObject({ floor: '2.1.400', target: 'latest' });
    expect(jsonVariation).toHaveBeenCalledWith('claude-code-update-policy', ada, null, box);
    vi.mocked(jsonVariation).mockResolvedValueOnce({ mode: 'manual' });
    expect(await TOOL_REGISTRY.claude.enabled(ada, box)).toBe(true);
    expect(jsonVariation).toHaveBeenLastCalledWith('claude-code-update-policy', ada, null, box);
    expect(boolVariation).not.toHaveBeenCalled();
  });

  it('reads Codex\'s own policy, with Codex\'s defaults under a bad key', async () => {
    vi.mocked(jsonVariation).mockResolvedValueOnce({ floor: '0.165.0', target: 'stable', restart: 'force' });
    expect(await TOOL_REGISTRY.codex.policy(ada, box)).toEqual({ mode: 'off', floor: '0.165.0', target: 'latest', restart: 'force', drainSec: 600, forceAfterHours: 24 });
    expect(jsonVariation).toHaveBeenLastCalledWith('codex-update-policy', ada, null, box);
    vi.mocked(jsonVariation).mockResolvedValueOnce(null);
    expect(await TOOL_REGISTRY.codex.policy(ada, null)).toMatchObject({ floor: '0.131.0', target: 'latest', restart: 'none' });
    vi.mocked(jsonVariation).mockResolvedValueOnce({ mode: 'off' });
    expect(await TOOL_REGISTRY.codex.enabled(ada, box)).toBe(false);
    expect(jsonVariation).toHaveBeenLastCalledWith('codex-update-policy', ada, null, box);
    expect(boolVariation).not.toHaveBeenCalled();
  });

  it('reads Python\'s own policy, with Python\'s defaults under a bad key', async () => {
    vi.mocked(jsonVariation).mockResolvedValueOnce({ floor: '3.13.16', target: '3.14', restart: 'idle' });
    expect(await TOOL_REGISTRY.python.policy(ada, box)).toEqual({ mode: 'off', floor: '3.13.16', target: 'latest', restart: 'idle', drainSec: 600, forceAfterHours: 24 });
    expect(jsonVariation).toHaveBeenLastCalledWith('python-update-policy', ada, null, box);
    vi.mocked(jsonVariation).mockResolvedValueOnce(null);
    expect(await TOOL_REGISTRY.python.policy(ada, null)).toMatchObject({ floor: '3.13.18', target: 'latest', restart: 'none' });
    vi.mocked(jsonVariation).mockResolvedValueOnce({ mode: 'off' });
    expect(await TOOL_REGISTRY.python.enabled(ada, box)).toBe(false);
    expect(boolVariation).not.toHaveBeenCalled();
  });

  describe('enabled and auto, from the policy\'s mode alone', () => {
    const policyFlag = (c: string) => (c === 'claude' ? 'claude-code-update-policy' : `${c}-update-policy`);

    for (const c of TOOL_COMPONENTS) {
      it(`${c}: off, manual and auto decide; missing, malformed and the flag source down are off; no on/off flag is read`, async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const tool = TOOL_REGISTRY[c];
        expect(tool.policyFlag).toBe(policyFlag(c));
        vi.mocked(jsonVariation).mockClear();
        for (const [mode, enabled, auto] of [['off', false, false], ['manual', true, false], ['auto', true, true]] as const) {
          vi.mocked(jsonVariation).mockResolvedValue({ mode });
          expect(await tool.enabled(ada, box)).toBe(enabled);
          expect(await tool.auto(ada, box)).toBe(auto);
        }
        expect(jsonVariation).toHaveBeenCalledWith(policyFlag(c), ada, null, box);
        // Missing ({}), malformed, and null: what jsonVariation answers while the flag source cannot (the fallback).
        for (const value of [{}, { floor: '2.2.0' }, { mode: 'sometimes' }, { mode: null }, null]) {
          vi.mocked(jsonVariation).mockResolvedValue(value);
          expect(await tool.enabled(ada, box)).toBe(false);
          expect(await tool.auto(ada, box)).toBe(false);
          expect((await tool.policy(ada, box)).mode).toBe('off');
        }
        expect(boolVariation).not.toHaveBeenCalled();
        vi.mocked(jsonVariation).mockReset().mockResolvedValue({ floor: '2.1.400', target: 'nope' });
        vi.mocked(console.warn).mockRestore();
      });
    }

    it('takes a policy already read, and reads the flag no more', async () => {
      vi.mocked(jsonVariation).mockClear();
      const policy = await TOOL_REGISTRY.docker.policy(ada, box);
      expect(jsonVariation).toHaveBeenCalledTimes(1);
      expect(await TOOL_REGISTRY.docker.enabled(ada, box, { ...policy, mode: 'manual' })).toBe(true);
      expect(await TOOL_REGISTRY.docker.auto(ada, box, { ...policy, mode: 'manual' })).toBe(false);
      expect(jsonVariation).toHaveBeenCalledTimes(1);
      expect(boolVariation).not.toHaveBeenCalled();
    });
  });
});
