import { describe, it, expect, vi } from 'vitest';

const registry = vi.hoisted(() => ({ agent: null as unknown, sent: [] as unknown[] }));
const db = vi.hoisted(() => ({ updates: [] as { where: { id: string }; data: { githubDeliveredAt: Date | null } }[] }));
vi.mock('../db', () => ({
  prisma: {
    user: { findUnique: async () => ({ claudeGatewayEnabled: true }) },
    instance: {
      update: async (args: { where: { id: string }; data: { githubDeliveredAt: Date | null } }) => {
        db.updates.push(args);
        return {};
      },
    },
  },
}));
vi.mock('./agentRegistry', () => ({
  connectedOwnedBoxIds: () => [],
  instanceAgentTransport: () => registry.agent,
  sendToInstanceAgent: vi.fn(async (...args: unknown[]) => { registry.sent.push(args); }),
}));
const store = vi.hoisted(() => ({ config: null as unknown, read: async (): Promise<unknown> => null }));
vi.mock('./credentialStore', () => ({
  getCredentialStoreConfig: () => store.config,
  githubStoreDeps: () => ({ read: () => store.read() }),
}));

const mcp = vi.hoisted(() => ({ flag: true, connectors: [] as { id: string; name: string }[], fail: false }));
vi.mock('./mcpConnectorStore', () => ({
  mcpBrokerEnabledForBox: async () => mcp.flag,
  listConnectors: async () => {
    if (mcp.fail) throw new Error('db down');
    return mcp.connectors;
  },
}));

const fireworks = vi.hoisted(() => ({ flag: true, fail: false }));
vi.mock('./fireworksFlag', () => ({
  fireworksEnabledForBox: async () => {
    if (fireworks.fail) throw new Error('ld down');
    return fireworks.flag;
  },
}));

const { agentTelemetrySettings, deliverToInstance, deliveryInFlight, deliversGithub, planDelivery, providersFor, refusalFor, sessionTelemetrySettings, REASONS } = await import('./credentialDelivery');

const ec2Box = { kind: 'owned-box', user: { id: 'u' }, instance: { id: 'i', userId: 'u', kind: 'ec2' } } as never;
const externalBox = { kind: 'owned-box', user: { id: 'u' }, instance: { id: 'i', userId: 'u', kind: 'external' } } as never;
const V1 = ['credentials-v1'];

const BROKER = { url: 'https://agent.termag.example.com', login: 'octocat' };
const BOTH = ['credentials-v1', 'github-broker-v1'];
const OFF = { claudeSettings: null, claudeOffReason: 'claude-why', githubBroker: null, githubOffReason: 'github-why' };
const ALL = BOTH;

describe('planDelivery', () => {
  it('sends a broker-capable box the broker, and no GitHub token or key', () => {
    const steps = planDelivery({ ...OFF, claudeSettings: { env: {} }, githubBroker: BROKER }, BOTH);
    expect(steps).toEqual([
      { type: 'credentials-apply', provider: 'claude-gateway', payload: { env: {} } },
      { type: 'credentials-apply', provider: 'github', payload: { broker: 'https://agent.termag.example.com', login: 'octocat' } },
    ]);
    expect(JSON.stringify(steps)).not.toMatch(/token|ssh|PRIVATE/i);
  });

  it('removes GitHub from an agent that only knows the pre-broker delivery', () => {
    const [, github] = planDelivery({ ...OFF, githubBroker: BROKER }, ['credentials-v1']);
    expect(github).toEqual({ type: 'credentials-remove', provider: 'github', reason: REASONS.oldAgent });
  });

  it('removes what is not stored, and says why, so a box without credentials is never silent', () => {
    expect(planDelivery(OFF, BOTH)).toEqual([
      { type: 'credentials-remove', provider: 'claude-gateway', reason: 'claude-why' },
      { type: 'credentials-remove', provider: 'github', reason: 'github-why' },
    ]);
  });
});

describe('providersFor', () => {
  it('offers the Claude gateway and GitHub to every agent', () => {
    expect(providersFor(BOTH)).toEqual(['claude-gateway', 'github']);
    expect(providersFor(V1)).toEqual(['claude-gateway', 'github']);
  });
});

describe('deliversGithub', () => {
  it('needs the credential store and a broker URL, as delivery does', () => {
    const before = store.config;
    try {
      store.config = { kmsKeyArn: 'arn:aws:kms:us-east-2:000000000000:key/k' };
      expect(deliversGithub({ GITHUB_BROKER_URL: 'https://agent.termag.example.com' })).toBe(true);
      expect(deliversGithub({})).toBe(false);
      store.config = null;
      expect(deliversGithub({ GITHUB_BROKER_URL: 'https://agent.termag.example.com' })).toBe(false);
    } finally {
      store.config = before;
    }
  });
});

describe('refusalFor', () => {
  it('needs a managed box, and nothing about how it connected', () => {
    expect(refusalFor({ conn: ec2Box, capabilities: V1 })).toBeNull();
    expect(refusalFor({ conn: { kind: 'user-agent', user: { id: 'u' } } as never, capabilities: V1 })).toBe(REASONS.notManaged);
  });

  it("never counts a user's own external machine, even with the capability", () => {
    expect(refusalFor({ conn: externalBox, capabilities: V1 })).toBe(REASONS.notManaged);
  });
});

describe('deliverToInstance', () => {
  const sentSteps = () => registry.sent.map(([, type, body]) => ({ type, ...(body as object) }));

  it('sends an external box no credential, only removes that say why', async () => {
    registry.agent = { conn: externalBox, capabilities: V1 };
    registry.sent = [];
    await deliverToInstance('i', 'u');
    expect(sentSteps()).toEqual([
      { type: 'credentials-remove', provider: 'claude-gateway', reason: REASONS.notManaged },
      { type: 'credentials-remove', provider: 'github', reason: REASONS.notManaged },
    ]);
  });

  it("plans a managed box's delivery from what is stored, not from how its agent connected", async () => {
    registry.agent = { conn: ec2Box, capabilities: V1 };
    registry.sent = [];
    await deliverToInstance('i', 'u');
    expect(sentSteps().map(s => (s as { reason?: string }).reason)).toEqual([REASONS.noGateway, REASONS.noStore]);
  });

  it('only removes, with reasons, on a managed box while the orchestrator has none of the env', async () => {
    registry.agent = { conn: ec2Box, capabilities: BOTH };
    registry.sent = [];
    await deliverToInstance('i', 'u');
    expect(sentSteps()).toEqual([
      { type: 'credentials-remove', provider: 'claude-gateway', reason: REASONS.noGateway },
      { type: 'credentials-remove', provider: 'github', reason: REASONS.noStore },
    ]);
  });

  it('tells a box it does not manage why it gets no credentials', async () => {
    registry.agent = { conn: externalBox, capabilities: V1 };
    registry.sent = [];
    await deliverToInstance('i', 'u');
    expect(sentSteps().map(s => (s as { provider?: string }).provider)).toEqual(['claude-gateway', 'github']);
  });

  it('still delivers Claude when the GitHub row cannot be decrypted, and leaves GitHub as it was', async () => {
    const env = {
      CLAUDE_GATEWAY_URL: 'https://claude-gateway.termag.example.com',
      CLAUDE_BEDROCK_REGION: 'us-east-2',
      CLAUDE_BEDROCK_MODELS: 'opus=us.anthropic.claude-opus-5-5,sonnet=us.anthropic.claude-sonnet-5-5,haiku=us.anthropic.claude-haiku-4-5',
      GITHUB_BROKER_URL: BROKER.url,
    };
    const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
    Object.assign(process.env, env);
    store.config = { kmsKeyId: 'k' };
    store.read = async () => { throw new Error('KMS unavailable'); };
    registry.agent = { conn: ec2Box, capabilities: ALL };
    registry.sent = [];
    try {
      await expect(deliverToInstance('i', 'u')).rejects.toThrow('KMS unavailable');
      expect(sentSteps().map(s => `${s.type} ${(s as { provider: string }).provider}`)).toEqual([
        'credentials-apply claude-gateway',
      ]);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      store.config = null;
      store.read = async () => null;
    }
  });

  it('sends nothing to an agent that predates credentials-v1', async () => {
    registry.agent = { conn: ec2Box, capabilities: [] };
    registry.sent = [];
    db.updates = [];
    await deliverToInstance('i', 'u');
    expect(registry.sent).toEqual([]);
    expect(db.updates).toEqual([]);
  });

  it('stamps githubDeliveredAt when the github apply resolves, and clears it on remove', async () => {
    const prev = process.env.GITHUB_BROKER_URL;
    process.env.GITHUB_BROKER_URL = 'https://agent.termag.example.com';
    store.config = { kmsKeyId: 'k' };
    registry.agent = { conn: ec2Box, capabilities: BOTH };
    try {
      store.read = async () => ({ login: 'octocat' });
      db.updates = [];
      registry.sent = [];
      await deliverToInstance('i', 'u');
      expect(db.updates).toHaveLength(1);
      expect(db.updates[0].where).toEqual({ id: 'i' });
      const stamped = db.updates[0].data.githubDeliveredAt;
      expect(stamped).toBeInstanceOf(Date);
      expect(Math.abs((stamped as Date).getTime() - Date.now())).toBeLessThan(5000);

      store.read = async () => null;
      db.updates = [];
      await deliverToInstance('i', 'u');
      expect(db.updates).toEqual([{ where: { id: 'i' }, data: { githubDeliveredAt: null } }]);
    } finally {
      if (prev === undefined) delete process.env.GITHUB_BROKER_URL;
      else process.env.GITHUB_BROKER_URL = prev;
      store.config = null;
      store.read = async () => null;
    }
  });

  it('does not stamp when the github send throws', async () => {
    const { sendToInstanceAgent } = await import('./agentRegistry');
    const prev = process.env.GITHUB_BROKER_URL;
    process.env.GITHUB_BROKER_URL = 'https://agent.termag.example.com';
    store.config = { kmsKeyId: 'k' };
    store.read = async () => ({ login: 'octocat' });
    registry.agent = { conn: ec2Box, capabilities: BOTH };
    db.updates = [];
    vi.mocked(sendToInstanceAgent).mockImplementation(async (...args: unknown[]) => {
      const body = args[2] as { provider?: string };
      if (body?.provider === 'github') throw new Error('broker down');
    });
    try {
      await expect(deliverToInstance('i', 'u')).rejects.toThrow('broker down');
      expect(db.updates).toEqual([]);
    } finally {
      vi.mocked(sendToInstanceAgent).mockImplementation(async (...args: unknown[]) => {
        registry.sent.push(args);
      });
      if (prev === undefined) delete process.env.GITHUB_BROKER_URL;
      else process.env.GITHUB_BROKER_URL = prev;
      store.config = null;
      store.read = async () => null;
    }
  });

  it('does not stamp when the only step is claude', async () => {
    const env = {
      CLAUDE_GATEWAY_URL: 'https://claude-gateway.termag.example.com',
      CLAUDE_BEDROCK_REGION: 'us-east-2',
      CLAUDE_BEDROCK_MODELS: 'opus=us.anthropic.claude-opus-5-5,sonnet=us.anthropic.claude-sonnet-5-5,haiku=us.anthropic.claude-haiku-4-5',
    };
    const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
    Object.assign(process.env, env);
    store.config = { kmsKeyId: 'k' };
    store.read = async () => { throw new Error('KMS unavailable'); };
    registry.agent = { conn: ec2Box, capabilities: V1 };
    registry.sent = [];
    db.updates = [];
    try {
      await expect(deliverToInstance('i', 'u')).rejects.toThrow('KMS unavailable');
      expect(sentSteps().map(s => `${s.type} ${(s as { provider: string }).provider}`)).toEqual([
        'credentials-apply claude-gateway',
      ]);
      expect(db.updates).toEqual([]);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      store.config = null;
      store.read = async () => null;
    }
  });
});

describe('planDelivery: telemetry', () => {
  const TELEMETRY = sessionTelemetrySettings(
    { project: '5f0c1e2d3a4b5c6d7e8f9a0b', endpoint: 'https://otel.example.test' },
    { user: 'cmuser01', box: 'cm_box-02' },
  );

  it('sends a telemetry-v1 box metrics, events and traces to the project, with both context keys and no content gate', () => {
    const steps = planDelivery({ ...OFF, telemetry: TELEMETRY }, [...ALL, 'telemetry-v1']);
    expect(steps).toContainEqual({ type: 'credentials-apply', provider: 'telemetry', payload: TELEMETRY });
    expect(TELEMETRY.env).toMatchObject({
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
      OTEL_TRACES_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.test',
      OTEL_RESOURCE_ATTRIBUTES: 'telemetry.project_id=5f0c1e2d3a4b5c6d7e8f9a0b,service.name=termag-claude-session,termag.agent=claude,termag.session.kind=interactive,termag.user.id=cmuser01,termag.box.id=cm_box-02',
    });
    expect(Object.keys(TELEMETRY.env).filter(k => k.startsWith('OTEL_LOG_'))).toEqual([]);
  });

  it("blanks every header, client credential and per-signal endpoint the owner's shell could set, and fills none", () => {
    const blank = Object.entries(TELEMETRY.env).filter(([k]) => /HEADERS|CLIENT_|_(METRICS|LOGS|TRACES)_(ENDPOINT|PROTOCOL)$/.test(k));
    expect(blank.map(([k]) => k)).toEqual(expect.arrayContaining([
      'OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_EXPORTER_OTLP_CLIENT_KEY', 'OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE',
      'OTEL_EXPORTER_OTLP_TRACES_HEADERS', 'OTEL_EXPORTER_OTLP_METRICS_CLIENT_KEY', 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
      'OTEL_EXPORTER_OTLP_TRACES_PROTOCOL',
    ]));
    expect(blank).toHaveLength(18);
    expect(blank.every(([, v]) => v === '')).toBe(true);
  });

  it('leaves the context keys out rather than write one that would need escaping', () => {
    const { env } = sessionTelemetrySettings({ project: 'p1', endpoint: 'https://otel.example.test' }, { user: 'u,x=y', box: 'b1' });
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe('telemetry.project_id=p1,service.name=termag-claude-session,termag.agent=claude,termag.session.kind=interactive');
  });

  it('names the agent on the Claude resource, as the other agents name theirs', () => {
    const { env } = sessionTelemetrySettings({ project: 'p1', endpoint: 'https://otel.example.test' }, { user: 'u1', box: 'b1' });
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain(',termag.agent=claude,termag.session.kind=interactive');
  });

  it('removes telemetry, with the reason, when the orchestrator ships none', () => {
    expect(planDelivery(OFF, [...ALL, 'telemetry-v1'])).toContainEqual({ type: 'credentials-remove', provider: 'telemetry', reason: REASONS.noTelemetry });
  });

  it('sends an agent without telemetry-v1 no telemetry step, and leaves it out of its providers', () => {
    expect(planDelivery({ ...OFF, telemetry: TELEMETRY }, ALL).some(s => s.provider === 'telemetry')).toBe(false);
    expect(providersFor(ALL)).not.toContain('telemetry');
    expect(providersFor([...ALL, 'telemetry-v1'])).toContain('telemetry');
  });
});

describe('planDelivery: agent telemetry', () => {
  const DEST = { project: '5f0c1e2d3a4b5c6d7e8f9a0b', endpoint: 'https://otel.example.test' };
  const AGENTS = agentTelemetrySettings(DEST, { user: 'cmuser01', box: 'cm_box-02' });

  it("sends an agent-telemetry-v1 box only the destination and Claude's resource without its service name", () => {
    expect(AGENTS).toEqual({
      endpoint: 'https://otel.example.test',
      resourceAttributes: 'telemetry.project_id=5f0c1e2d3a4b5c6d7e8f9a0b,termag.session.kind=interactive,termag.user.id=cmuser01,termag.box.id=cm_box-02',
    });
    const steps = planDelivery({ ...OFF, agentTelemetry: AGENTS }, [...ALL, 'agent-telemetry-v1']);
    expect(steps).toContainEqual({ type: 'credentials-apply', provider: 'agent-telemetry', payload: AGENTS });
  });

  it('shares the context keys, and their refusal, with the Claude Code resource', () => {
    const claude = sessionTelemetrySettings(DEST, { user: 'cmuser01', box: 'cm_box-02' }).env.OTEL_RESOURCE_ATTRIBUTES;
    expect(claude).toBe(AGENTS.resourceAttributes.replace(',termag.session', ',service.name=termag-claude-session,termag.agent=claude,termag.session'));
    expect(agentTelemetrySettings(DEST, { user: 'u,x=y', box: 'b1' }).resourceAttributes)
      .toBe('telemetry.project_id=5f0c1e2d3a4b5c6d7e8f9a0b,termag.session.kind=interactive');
  });

  it('removes agent telemetry, with the reason, when the orchestrator ships none', () => {
    expect(planDelivery(OFF, [...ALL, 'agent-telemetry-v1']))
      .toContainEqual({ type: 'credentials-remove', provider: 'agent-telemetry', reason: REASONS.noAgentTelemetry });
  });

  it('sends an agent without agent-telemetry-v1 no step, whatever else it advertises', () => {
    const steps = planDelivery({ ...OFF, agentTelemetry: AGENTS }, [...ALL, 'telemetry-v1', 'telemetry-replay-v1']);
    expect(steps.some(s => s.provider === 'agent-telemetry')).toBe(false);
    expect(providersFor([...ALL, 'telemetry-v1'])).not.toContain('agent-telemetry');
    expect(providersFor([...ALL, 'agent-telemetry-v1'])).toContain('agent-telemetry');
  });
});

describe('planDelivery: mcp', () => {
  const MCP = { broker: 'https://mcp-broker.example.test', connectors: [{ id: 'c1', name: 'figma' }] };
  const CAPS = [...ALL, 'mcp-broker-v1'];

  it('sends an mcp-broker-v1 box the broker and connector ids and names, nothing secret', () => {
    const steps = planDelivery({ ...OFF, mcp: MCP }, CAPS);
    expect(steps).toContainEqual({ type: 'credentials-apply', provider: 'mcp', payload: MCP });
  });

  it('removes mcp with the reason when the broker is off for this box', () => {
    expect(planDelivery({ ...OFF, mcp: null, mcpOffReason: REASONS.mcpOff }, CAPS))
      .toContainEqual({ type: 'credentials-remove', provider: 'mcp', reason: REASONS.mcpOff });
    expect(planDelivery(OFF, CAPS)).toContainEqual({ type: 'credentials-remove', provider: 'mcp', reason: REASONS.noMcpBroker });
  });

  it('sends no mcp step when the connectors could not be read, or to an agent without mcp-broker-v1', () => {
    expect(planDelivery({ ...OFF, mcpUnknown: true }, CAPS).some(s => s.provider === 'mcp')).toBe(false);
    expect(planDelivery({ ...OFF, mcp: MCP }, ALL).some(s => s.provider === 'mcp')).toBe(false);
    expect(providersFor(ALL)).not.toContain('mcp');
    expect(providersFor(CAPS)).toContain('mcp');
  });
});

describe('deliverToInstance: mcp', () => {
  const mcpSteps = () => (registry.sent as [string, string, { provider: string }][]).filter(([, , p]) => p.provider === 'mcp');

  it('applies the connectors when the broker is configured and the flag is on, and removes them when it is off', async () => {
    process.env.MCP_BROKER_URL = 'https://mcp-broker.example.test/';
    try {
      registry.agent = { conn: ec2Box, capabilities: ['credentials-v1', 'mcp-broker-v1'] };
      mcp.flag = true;
      mcp.connectors = [{ id: 'c1', name: 'figma' }];
      registry.sent = [];
      await deliverToInstance('i', 'u');
      expect(mcpSteps()).toEqual([['i', 'credentials-apply', { provider: 'mcp', payload: { broker: 'https://mcp-broker.example.test', connectors: [{ id: 'c1', name: 'figma' }] } }, 30_000]]);
      mcp.flag = false;
      registry.sent = [];
      await deliverToInstance('i', 'u');
      expect(mcpSteps()).toEqual([['i', 'credentials-remove', { provider: 'mcp', reason: REASONS.mcpOff }, 30_000]]);
      mcp.flag = true;
      mcp.fail = true;
      registry.sent = [];
      await deliverToInstance('i', 'u');
      expect(mcpSteps()).toEqual([]);
    } finally {
      delete process.env.MCP_BROKER_URL;
      mcp.fail = false;
    }
  });
});

describe('planDelivery: fireworks', () => {
  const FW = { baseUrl: 'https://claude-gateway.example.test/fireworks' };
  const CAPS = [...ALL, 'fireworks-v1'];

  it('sends a fireworks-v1 box the gateway base, nothing secret and no model list', () => {
    expect(planDelivery({ ...OFF, fireworks: FW }, CAPS)).toContainEqual({ type: 'credentials-apply', provider: 'fireworks', payload: FW });
  });

  it('removes fireworks with the reason when the flag is off or there is no gateway', () => {
    expect(planDelivery({ ...OFF, fireworks: null, fireworksOffReason: REASONS.fireworksOff }, CAPS))
      .toContainEqual({ type: 'credentials-remove', provider: 'fireworks', reason: REASONS.fireworksOff });
    expect(planDelivery(OFF, CAPS)).toContainEqual({ type: 'credentials-remove', provider: 'fireworks', reason: REASONS.noFireworks });
  });

  it('sends no fireworks step when the flag could not be read, or to an agent without fireworks-v1', () => {
    expect(planDelivery({ ...OFF, fireworksUnknown: true }, CAPS).some(s => s.provider === 'fireworks')).toBe(false);
    expect(planDelivery({ ...OFF, fireworks: FW }, ALL).some(s => s.provider === 'fireworks')).toBe(false);
    expect(providersFor(ALL)).not.toContain('fireworks');
    expect(providersFor(CAPS)).toContain('fireworks');
  });
});

describe('deliverToInstance: fireworks', () => {
  const steps = () => (registry.sent as [string, string, { provider: string }][]).filter(([, , p]) => p.provider === 'fireworks');

  it('applies the gateway base (no model list) when it is configured and the flag is on, removes it when off, and leaves it when the flag cannot be read', async () => {
    process.env.FIREWORKS_GATEWAY_URL = 'https://claude-gateway.example.test/fireworks/';
    try {
      registry.agent = { conn: ec2Box, capabilities: ['credentials-v1', 'fireworks-v1'] };
      fireworks.flag = true;
      registry.sent = [];
      await deliverToInstance('i', 'u');
      expect(steps()).toEqual([['i', 'credentials-apply', {
        provider: 'fireworks',
        payload: { baseUrl: 'https://claude-gateway.example.test/fireworks' },
      }, 30_000]]);
      fireworks.flag = false;
      registry.sent = [];
      await deliverToInstance('i', 'u');
      expect(steps()).toEqual([['i', 'credentials-remove', { provider: 'fireworks', reason: REASONS.fireworksOff }, 30_000]]);
      fireworks.fail = true;
      registry.sent = [];
      await deliverToInstance('i', 'u');
      expect(steps()).toEqual([]);
    } finally {
      delete process.env.FIREWORKS_GATEWAY_URL;
      fireworks.fail = false;
    }
  });
});

describe('deliveryInFlight', () => {
  const tick = () => new Promise(r => setImmediate(r));

  it('names the delivery to a box while it runs and forgets it once it has settled, however it ended', async () => {
    expect(deliveryInFlight('i')).toBeNull();
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const { sendToInstanceAgent } = await import('./agentRegistry');
    vi.mocked(sendToInstanceAgent).mockImplementationOnce(async () => { await held; throw new Error('box said no'); });
    registry.agent = { conn: externalBox, capabilities: V1 };
    registry.sent = [];
    const run = deliverToInstance('i', 'u');
    const waiting = deliveryInFlight('i');
    expect(waiting).not.toBeNull();
    release();
    await expect(run).rejects.toThrow('box said no');
    // The waiter settles (resolves) although the delivery failed: the failure is the starter's to log.
    await expect(waiting).resolves.toBeUndefined();
    await tick();
    expect(deliveryInFlight('i')).toBeNull();
  });

  it('settles only once every overlapping delivery to the box has (a claim and a credential change at once)', async () => {
    const pending: Array<() => void> = [];
    const { sendToInstanceAgent } = await import('./agentRegistry');
    vi.mocked(sendToInstanceAgent).mockImplementation(() => new Promise<void>(r => { pending.push(r); }));
    registry.agent = { conn: externalBox, capabilities: V1 };
    registry.sent = [];
    const first = deliverToInstance('i', 'u');
    const second = deliverToInstance('i', 'u');
    let settled = false;
    const waiting = deliveryInFlight('i')!.then(() => { settled = true; });
    await tick();
    // An external box gets two removes per delivery, sent one after the other.
    expect(pending.length).toBe(2);
    pending.shift()!(); await tick();   // first's remove 1 done, its remove 2 pending
    pending.shift()!(); await tick();   // second's remove 1 done, its remove 2 pending
    pending.shift()!(); await first; await tick();  // first finished entirely
    expect(settled).toBe(false);
    expect(deliveryInFlight('i')).not.toBeNull();
    pending.shift()!(); await second; await waiting;
    expect(settled).toBe(true);
    await tick();
    expect(deliveryInFlight('i')).toBeNull();
    vi.mocked(sendToInstanceAgent).mockImplementation(async (...args: unknown[]) => { registry.sent.push(args); });
  });
});
