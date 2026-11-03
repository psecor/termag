import { describe, expect, it, vi } from 'vitest';
import { boolVariation, jsonVariation } from '../featureFlags';
import { PROVIDERS } from '../../providers/registry';
import { TOOL_COMPONENTS, TOOL_REGISTRY, isToolComponent, toolDescriptor } from './components';
import { TOOL_UPDATE_CAPABILITY } from './run';

vi.mock('../featureFlags', () => ({ boolVariation: vi.fn(async () => true), jsonVariation: vi.fn(async () => ({ floor: '2.1.400', target: 'nope' })) }));

const ada = { id: 'u1', unixUsername: 'ada', googleEmail: 'ada@example.test', displayName: 'Ada', defaultAgentProvider: 'claude' };
const box = { id: 'box-a', name: 'a', kind: 'ec2' };

describe('the tool registry', () => {
  it('lists Claude Code, Codex, the Cursor agent and the Devin CLI, keyed by their component', () => {
    expect(TOOL_COMPONENTS).toEqual(['claude', 'codex', 'cursor', 'devin', 'pi', 'gh', 'aws', 'node']);
    expect(TOOL_REGISTRY.node).toMatchObject({ displayName: 'Node', inventoryName: 'node', providers: [], runnerFloor: false, capability: 'tool-update-node-v1' });
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
    for (const c of ['cursor-agent', 'python', 'Codex', '', null, undefined, 'constructor', '__proto__']) {
      expect(toolDescriptor(c)).toBeNull();
      expect(isToolComponent(c)).toBe(false);
    }
  });

  it('reads Claude Code\'s policy and flag for the owner and the box', async () => {
    expect(await TOOL_REGISTRY.claude.policy(ada, box)).toMatchObject({ floor: '2.1.400', target: 'latest' });
    expect(jsonVariation).toHaveBeenCalledWith('claude-code-update-policy', ada, null, box);
    expect(await TOOL_REGISTRY.claude.enabled(ada, box)).toBe(true);
    expect(boolVariation).toHaveBeenCalledWith('claude-code-update-enabled', ada, false, box);
  });

  it('reads Codex\'s own policy and flag, with Codex\'s defaults under a bad key', async () => {
    vi.mocked(jsonVariation).mockResolvedValueOnce({ floor: '0.165.0', target: 'stable', restart: 'force' });
    expect(await TOOL_REGISTRY.codex.policy(ada, box)).toEqual({ floor: '0.165.0', target: 'latest', restart: 'force', drainSec: 600, forceAfterHours: 24 });
    expect(jsonVariation).toHaveBeenLastCalledWith('codex-update-policy', ada, null, box);
    vi.mocked(jsonVariation).mockResolvedValueOnce(null);
    expect(await TOOL_REGISTRY.codex.policy(ada, null)).toMatchObject({ floor: '0.131.0', target: 'latest', restart: 'none' });
    vi.mocked(boolVariation).mockResolvedValueOnce(false);
    expect(await TOOL_REGISTRY.codex.enabled(ada, box)).toBe(false);
    expect(boolVariation).toHaveBeenLastCalledWith('codex-update-enabled', ada, false, box);
  });
});
