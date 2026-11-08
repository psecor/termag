import { describe, expect, it, vi } from 'vitest';
import { CATALOG_READ_TOOLS, CHAT_CONFINED_MCP_CAPABILITY, automationStaysWithOwner, brokerMcpFor, readToolRules, type AutomationOutputs, type BrokerMcpDeps, type BrokerMcpTarget, type SpaceReaders } from './chatConfinedMcp';
import { chatResumeClaimPayload, chatSendRpcPayload } from './chatRunner';

const BROKER = 'https://mcp-broker.example.test';
const SLACK = 'https://mcp.slack.com/mcp';
const ATLASSIAN = 'https://mcp.atlassian.com/v1/mcp';
const CATALOG = [
  { name: 'slack', upstream: SLACK },
  { name: 'atlassian', upstream: ATLASSIAN },
  { name: 'datadog', upstream: 'https://mcp.datadog.example.test/mcp' },
];

// agent/broker-mcp.js TOOL_RULE: a rule the box would drop is a rule that does nothing.
const AGENT_TOOL_RULE = /^mcp__([a-z][a-z0-9-]{0,40})__([A-Za-z0-9_-]{1,64})(\*?)$/;

describe('CATALOG_READ_TOOLS', () => {
  it('lists reads only: no rule starts with a verb that writes', () => {
    const writes = /^(slack_)?(create|update|delete|edit|send|post|schedule|add|remove|set|toggle|archive|apply|copy|invite|link|unlink|run|start|stop|save|transition|execute|upload|complete|publish|move)/i;
    for (const [name, tools] of Object.entries(CATALOG_READ_TOOLS)) {
      for (const t of tools.allow) expect(t, `${name}: ${t}`).not.toMatch(writes);
      // A whole server is never allowed: a prefix has something before its *.
      for (const t of tools.allow) expect(t, `${name}: ${t}`).not.toBe('*');
    }
  });

  it('makes only rules the box keeps', () => {
    for (const [name, tools] of Object.entries(CATALOG_READ_TOOLS)) {
      for (const t of [...tools.allow, ...(tools.deny ?? [])]) expect(`mcp__${name}__${t}`, name).toMatch(AGENT_TOOL_RULE);
    }
  });
});

describe('readToolRules', () => {
  it('gives each catalog connector its server\'s reads under the connector\'s own name, matched by URL', () => {
    const rules = readToolRules([
      { name: 'slack', upstream: SLACK },
      // Renamed, or made under another name: still Atlassian's server.
      { name: 'jira', upstream: ATLASSIAN },
    ], CATALOG);
    expect(rules.allow).toEqual([
      ...CATALOG_READ_TOOLS.slack.allow.map(t => `mcp__slack__${t}`),
      ...CATALOG_READ_TOOLS.atlassian.allow.map(t => `mcp__jira__${t}`),
    ]);
    expect(rules.deny).toEqual([]);
  });

  it('gives nothing to a connector added by hand, one named like a catalog server, or a catalog server with no list', () => {
    expect(readToolRules([
      { name: 'slack', upstream: 'https://slack.evil.example/mcp' },
      { name: 'datadog', upstream: 'https://mcp.datadog.example.test/mcp' },
    ], CATALOG)).toEqual({ allow: [], deny: [] });
    expect(readToolRules([{ name: 'x', upstream: SLACK }], [{ name: 'constructor', upstream: SLACK }, { name: '__proto__', upstream: SLACK }])).toEqual({ allow: [], deny: [] });
    expect(readToolRules([{ name: 'slack', upstream: SLACK }], [])).toEqual({ allow: [], deny: [] });
  });
});

const OWNER_CTX = { user: { id: 'u1', googleEmail: 'o@example.test', displayName: 'O', unixUsername: 'o', defaultAgentProvider: 'claude' }, box: { id: 'i1', name: 'box', kind: 'ec2' } };

function deps(over: Partial<BrokerMcpDeps> = {}): BrokerMcpDeps {
  return {
    flagOn: vi.fn(async () => true),
    owner: vi.fn(async () => OWNER_CTX),
    broker: () => BROKER,
    connectors: vi.fn(async () => [{ name: 'slack', upstream: SLACK }, { name: 'mine', upstream: 'https://mine.example.test/mcp' }]),
    catalog: vi.fn(async () => CATALOG),
    automation: vi.fn(async () => null),
    spaceReaders: vi.fn(async () => null),
    ...over,
  };
}

const target = (over: Partial<BrokerMcpTarget> = {}): BrokerMcpTarget => ({
  projectId: 'p1', workstreamId: 'ws1', isOwner: true, ownerId: 'u1', instanceId: 'i1', agentCapabilities: [CHAT_CONFINED_MCP_CAPABILITY], ask: null, engine: 'claude', ...over,
});

describe('brokerMcpFor', () => {
  it('the owner\'s turn: their connectors through this broker, with the catalog reads', async () => {
    const d = deps();
    expect(await brokerMcpFor(target(), d)).toEqual({
      connectors: 'owner', broker: BROKER,
      allow: CATALOG_READ_TOOLS.slack.allow.map(t => `mcp__slack__${t}`), deny: [],
    });
    // Read for the box's owner and the box, not for whoever sent.
    expect(d.owner).toHaveBeenCalledWith('u1', 'i1');
    expect(d.flagOn).toHaveBeenCalledWith(OWNER_CTX.user, OWNER_CTX.box);
    expect(d.connectors).toHaveBeenCalledWith('u1');
  });

  it('anyone else\'s turn on the owner\'s box (a sharee\'s): none, on either engine, without reading the connectors', async () => {
    for (const engine of ['claude', 'pi'] as const) {
      const d = deps();
      expect(await brokerMcpFor(target({ isOwner: false, engine }), d)).toEqual({ connectors: 'none', broker: BROKER });
      expect(d.connectors).not.toHaveBeenCalled();
    }
    // Without a broker the box denies its record's connectors alone.
    expect(await brokerMcpFor(target({ isOwner: false }), deps({ broker: () => null }))).toEqual({ connectors: 'none' });
  });

  it('nothing with the flag off for the owner, on an older agent, for an ask, without a box or a broker, or on pi for the owner', async () => {
    expect(await brokerMcpFor(target(), deps({ flagOn: async () => false }))).toBeNull();
    expect(await brokerMcpFor(target({ isOwner: false }), deps({ flagOn: async () => false }))).toBeNull();
    const old = deps();
    expect(await brokerMcpFor(target({ agentCapabilities: ['chat-runner-v1'] }), old)).toBeNull();
    expect(old.owner).not.toHaveBeenCalled();
    expect(await brokerMcpFor(target({ ask: { threadId: 't' } }), deps())).toBeNull();
    expect(await brokerMcpFor(target({ isOwner: false, ask: { threadId: 't' } }), deps())).toBeNull();
    expect(await brokerMcpFor(target({ instanceId: null }), deps())).toBeNull();
    expect(await brokerMcpFor(target(), deps({ broker: () => null }))).toBeNull();
    expect(await brokerMcpFor(target({ engine: 'pi' }), deps())).toBeNull();
  });

  it('a read that fails, or a flag the flag source could not answer: nothing for the owner, none for a sharee', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const down = async () => { throw new Error('db down'); };
    expect(await brokerMcpFor(target(), deps({ connectors: down }))).toBeNull();
    expect(await brokerMcpFor(target(), deps({ owner: down }))).toBeNull();
    expect(await brokerMcpFor(target(), deps({ flagOn: async () => null }))).toBeNull();
    expect(await brokerMcpFor(target(), deps({ owner: async () => null }))).toBeNull();
    for (const over of [{ owner: down }, { flagOn: async () => null }, { flagOn: down }, { owner: async () => null }]) {
      expect(await brokerMcpFor(target({ isOwner: false }), deps(over))).toEqual({ connectors: 'none', broker: BROKER });
    }
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('the frames carry brokerMcp only to an agent that reads it', () => {
  const chat = { chatKey: 'p1--ws1', cwd: '/w/p1', projectId: 'p1', workstream: 'main', workstreamId: 'ws1', requireCheckout: false, permissionMode: 'dontAsk' };
  const field = { connectors: 'owner' as const, broker: BROKER, allow: ['mcp__slack__slack_read_*'], deny: [] };

  it('chat-send', () => {
    expect(chatSendRpcPayload(chat, 'hi', [CHAT_CONFINED_MCP_CAPABILITY], { brokerMcp: field }).brokerMcp).toEqual(field);
    expect(chatSendRpcPayload(chat, 'hi', [CHAT_CONFINED_MCP_CAPABILITY], { brokerMcp: { connectors: 'none' } }).brokerMcp).toEqual({ connectors: 'none' });
    expect(chatSendRpcPayload(chat, 'hi', ['chat-runner-v1'], { brokerMcp: field })).not.toHaveProperty('brokerMcp');
    expect(chatSendRpcPayload(chat, 'hi', [CHAT_CONFINED_MCP_CAPABILITY], { brokerMcp: null })).not.toHaveProperty('brokerMcp');
    expect(chatSendRpcPayload(chat, 'hi', [CHAT_CONFINED_MCP_CAPABILITY])).not.toHaveProperty('brokerMcp');
  });

  it('chat-resume-claim', () => {
    expect(chatResumeClaimPayload(chat, [CHAT_CONFINED_MCP_CAPABILITY], field).brokerMcp).toEqual(field);
    expect(chatResumeClaimPayload(chat, ['chat-runner-v1'], field)).not.toHaveProperty('brokerMcp');
    expect(chatResumeClaimPayload(chat, [CHAT_CONFINED_MCP_CAPABILITY])).not.toHaveProperty('brokerMcp');
  });
});

const readers = (over: Partial<SpaceReaders> = {}): SpaceReaders => ({ memberIds: ['u1'], pendingInvites: 0, slackLinked: false, fileShares: 0, ...over });
const outputs = (over: Partial<AutomationOutputs> = {}): AutomationOutputs => ({ spaceNames: ['mine'], notifySlack: false, workstreamSlack: false, projectSharees: 0, ...over });

describe('automationStaysWithOwner', () => {
  it('a private space of the owner\'s, or no space, with nothing sent to Slack and the project shared with nobody', async () => {
    expect(await automationStaysWithOwner(outputs(), 'u1', async () => readers())).toBe(true);
    const lookup = vi.fn(async () => readers());
    expect(await automationStaysWithOwner(outputs({ spaceNames: [] }), 'u1', lookup)).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('not a shared space, someone else\'s, an empty one, one about to be shared, one with its own Slack, or one that is gone', async () => {
    for (const r of [readers({ memberIds: ['u1', 'u2'] }), readers({ memberIds: ['u2'] }), readers({ memberIds: [] }), readers({ pendingInvites: 1 }), readers({ slackLinked: true }), readers({ fileShares: 1 }), null]) {
      expect(await automationStaysWithOwner(outputs(), 'u1', async () => r), JSON.stringify(r)).toBe(false);
    }
  });

  it('not with the run report on, a Slack channel on the run\'s workstream, or the project shared, space or no space', async () => {
    for (const spaceNames of [['mine'], []]) {
      for (const over of [{ notifySlack: true }, { workstreamSlack: true }, { projectSharees: 1 }]) {
        expect(await automationStaysWithOwner(outputs({ spaceNames, ...over }), 'u1', async () => readers()), `${spaceNames} ${JSON.stringify(over)}`).toBe(false);
      }
    }
  });

  it('every space it touches must be private: a run chat left in a shared space after the automation moved (Devin Review, #1433)', async () => {
    const lookup = async (name: string) => (name === 'team' ? readers({ memberIds: ['u1', 'u2'] }) : readers());
    expect(await automationStaysWithOwner(outputs({ spaceNames: ['mine', 'team'] }), 'u1', lookup)).toBe(false);
    expect(await automationStaysWithOwner(outputs({ spaceNames: ['team', 'mine'] }), 'u1', lookup)).toBe(false);
    expect(await automationStaysWithOwner(outputs({ spaceNames: ['mine', 'mine'] }), 'u1', lookup)).toBe(true);
  });

  it('a space lookup that fails is not an answer: it throws to the caller', async () => {
    await expect(automationStaysWithOwner(outputs(), 'u1', async () => { throw new Error('db down'); })).rejects.toThrow('db down');
  });
});

describe('brokerMcpFor: an automation\'s turns', () => {
  const OWNER_FIELD = { connectors: 'owner', broker: BROKER, allow: CATALOG_READ_TOOLS.slack.allow.map(t => `mcp__slack__${t}`), deny: [] };

  it('when all the run produces stays with the owner: their connectors, as for any other turn of theirs', async () => {
    const d = deps({ automation: vi.fn(async () => outputs()), spaceReaders: vi.fn(async () => readers()) });
    expect(await brokerMcpFor(target(), d)).toEqual(OWNER_FIELD);
    expect(d.automation).toHaveBeenCalledWith('p1', 'ws1');
    expect(d.spaceReaders).toHaveBeenCalledWith('mine');
    expect(await brokerMcpFor(target(), deps({ automation: async () => outputs({ spaceNames: [] }) }))).toEqual(OWNER_FIELD);
  });

  it('a shared space, the Slack report, a Slack channel or a shared project: nothing', async () => {
    for (const [o, r] of [
      [outputs(), readers({ memberIds: ['u1', 'u2'] })],
      [outputs({ notifySlack: true }), readers()],
      [outputs({ spaceNames: [], notifySlack: true }), readers()],
      [outputs({ workstreamSlack: true }), readers()],
      [outputs({ spaceNames: [], projectSharees: 2 }), readers()],
      [outputs(), readers({ fileShares: 3 })],
    ] as const) {
      expect(await brokerMcpFor(target(), deps({ automation: async () => o, spaceReaders: async () => r })), JSON.stringify(o)).toBeNull();
    }
  });

  it('a lookup that fails is nothing (fail closed), with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const down = async () => { throw new Error('db down'); };
    expect(await brokerMcpFor(target(), deps({ automation: down }))).toBeNull();
    expect(await brokerMcpFor(target(), deps({ automation: async () => outputs(), spaceReaders: down }))).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a project that is not an automation is not asked about spaces; a sharee still gets none', async () => {
    const d = deps();
    expect(await brokerMcpFor(target(), d)).toEqual(OWNER_FIELD);
    expect(d.spaceReaders).not.toHaveBeenCalled();
    expect(await brokerMcpFor(target({ isOwner: false }), deps({ automation: async () => outputs({ notifySlack: true }) }))).toEqual({ connectors: 'none', broker: BROKER });
  });
});
