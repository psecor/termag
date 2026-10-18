import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

const db = {
  instances: [] as Row[],
  projects: [] as Row[],
  workstreams: [] as Row[],
  workflows: [] as Row[],
  credentials: [] as Row[],
};

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (want && typeof want === 'object' && 'in' in want) return want.in.includes(row[key]);
    if (want && typeof want === 'object' && 'not' in want) return row[key] !== want.not;
    return row[key] === want;
  });
}

function hydrate(p: Row, include: Row = {}): Row {
  const workstreams = db.workstreams.filter(w => w.projectId === p.id && matches(w, include.workstreams?.where));
  const user = { id: p.userId, unixUsername: 'alice', defaultAgentProvider: state.defaultProvider };
  return {
    ...p,
    workstreams,
    workflows: db.workflows.filter(w => w.projectId === p.id).map(w => ({
      ...w, workstream: { name: db.workstreams.find(ws => ws.id === w.workstreamId)?.name },
    })),
    instance: db.instances.find(i => i.id === p.instanceId) ?? null,
    user,
  };
}

function update(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    row[key] = value && typeof value === 'object' && 'increment' in value ? row[key] + value.increment : value;
  }
}

const prisma = {
  instance: {
    findFirst: vi.fn(async ({ where }: Row) => db.instances.find(i => matches(i, where)) ?? null),
    findUnique: vi.fn(async ({ where }: Row) => db.instances.find(i => i.id === where.id) ?? null),
  },
  project: {
    findFirst: vi.fn(async ({ where, include }: Row) => {
      const p = db.projects.find(r => matches(r, where));
      return p ? hydrate(p, include) : null;
    }),
    findUnique: vi.fn(async ({ where, include }: Row) => {
      const p = db.projects.find(r => r.id === where.id);
      return p ? hydrate(p, include) : null;
    }),
    findUniqueOrThrow: vi.fn(async ({ where, include }: Row) => hydrate(db.projects.find(r => r.id === where.id)!, include)),
    findMany: vi.fn(async ({ where, include }: Row) => db.projects.filter(r => matches(r, where)).map(p => hydrate(p, include))),
    create: vi.fn(async ({ data }: Row) => {
      const row = {
        id: `p${db.projects.length + 1}`, archived: false, repoUrl: null, repoDefaultBranch: null,
        setupStatus: 'none', setupError: null, setupAttempt: 0, ...data,
      };
      db.projects.push(row);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: Row) => {
      const rows = db.projects.filter(r => matches(r, where));
      for (const row of rows) update(row, data);
      return { count: rows.length };
    }),
    update: vi.fn(async ({ where, data }: Row) => {
      const row = db.projects.find(r => r.id === where.id)!;
      update(row, data);
      return row;
    }),
    delete: vi.fn(async ({ where }: Row) => {
      db.projects = db.projects.filter(r => r.id !== where.id);
      return {};
    }),
  },
  workstream: {
    upsert: vi.fn(async ({ where, create }: Row) => {
      const { projectId, name } = where.projectId_name;
      let ws = db.workstreams.find(w => w.projectId === projectId && w.name === name);
      if (!ws) db.workstreams.push(ws = { id: `ws${db.workstreams.length + 1}`, ...create });
      return { id: ws.id, name: ws.name };
    }),
    updateMany: vi.fn(async ({ where, data }: Row) => {
      const rows = db.workstreams.filter(w => matches(w, where));
      for (const row of rows) update(row, data);
      return { count: rows.length };
    }),
  },
  workflow: {
    create: vi.fn(async ({ data }: Row) => {
      const row = { id: `wf${db.workflows.length + 1}`, ...data };
      db.workflows.push(row);
      return row;
    }),
  },
  user: {
    findUnique: vi.fn(async () => ({ defaultAgentProvider: state.defaultProvider })),
  },
  userCredential: {
    findUnique: vi.fn(async ({ where }: Row) => db.credentials.find(c => c.userId === where.userId_provider.userId) ?? null),
  },
};

const state = {
  agent: null as null | { capabilities: string[]; helloReceived: boolean },
  defaultProvider: 'claude',
  foreground: '',
  /** The shell has not started the typed command yet, so the pane still shows the shell. */
  paneLags: false,
  probeFails: false,
  sent: [] as { type: string; payload: Record<string, unknown> }[],
};

const send = (type: string, payload: Record<string, unknown> = {}) => {
  state.sent.push({ type, payload });
  if (type === 'tmux-foreground-cmd') {
    if (state.probeFails) throw new Error('Agent request timed out: tmux-foreground-cmd');
    return { cmd: state.foreground };
  }
  if (type === 'tmux-send-keys' && !state.paneLags) {
    state.foreground = String(payload.keys).includes('git fetch') ? 'git' : 'claude';
  }
  return {};
};

const helloListeners: ((ev: any) => void)[] = [];
const frameListeners: ((frame: any) => void)[] = [];

vi.mock('../db', () => ({ prisma }));
vi.mock('../middleware/auth', () => ({ requireAuth: vi.fn(), requireAuthOrAgentToken: vi.fn() }));
vi.mock('../slack/channels', () => ({ createProjectChannel: vi.fn(async () => null) }));
vi.mock('../slack/lts', () => ({ setNotificationTarget: vi.fn() }));
vi.mock('./status', () => ({ deleteStatus: vi.fn(), setStatus: vi.fn(), notifyStatusChange: vi.fn() }));
vi.mock('./agentRegistry', () => ({
  isAgentConnected: vi.fn(() => state.agent !== null),
  isProjectAgentConnected: vi.fn(() => state.agent !== null),
  instanceAgentTransport: vi.fn(() => state.agent && { conn: {}, agentCommit: null, ...state.agent }),
  sendForProject: vi.fn(async (_host: unknown, type: string, payload?: Record<string, unknown>) => send(type, payload)),
  sendToInstanceAgent: vi.fn(async (_id: string, type: string, payload?: Record<string, unknown>) => send(type, payload)),
  sendToAgent: vi.fn(async (_id: string, type: string, payload?: Record<string, unknown>) => send(type, payload)),
  onBoxAgentHello: vi.fn((fn: (ev: unknown) => void) => { helloListeners.push(fn); return () => {}; }),
  onBoxAgentFrame: vi.fn((_type: string, fn: (frame: unknown) => void) => { frameListeners.push(fn); return () => {}; }),
}));

const { createProjectFor, retryCloneFor, startEmptyFor } = await import('../routes/projects');
const { applySetupEvent, redispatchClones, startProjectClone } = await import('./projectClone');
const { reconstructInstanceSessions, setPaneLaunchSettleForTests } = await import('./agentRuntime');
// Launches here follow one another into the same pane; the post-launch settle would only add waits.
setPaneLaunchSettleForTests(0);

const user = {
  id: 'u1', unixUsername: 'alice', defaultAgentProvider: 'claude',
  role: 'user', adminSource: null, googleEmail: 'alice@example.com',
} as unknown as Express.User;

const CAPABLE = ['credentials-v1', 'project-clone-v1'];
const DIR = '/home/alice/termag/projects/widget';
const WIDGET = 'https://github.com/acme/widget.git';

function box(id: string, kind = 'ec2') {
  return { id, userId: 'u1', kind, status: 'ready', hostHome: '/home/alice', name: `alice-${id}`, githubDeliveredAt: null, onClaimStatus: null };
}

beforeEach(() => {
  db.instances = [box('box1'), box('box2')];
  db.projects = [];
  db.workstreams = [];
  db.workflows = [];
  db.credentials = [];
  state.agent = null;
  state.defaultProvider = 'claude';
  state.foreground = '';
  state.paneLags = false;
  state.probeFails = false;
  state.sent = [];
  vi.clearAllMocks();
});

const project = () => db.projects[0];
const mainBranch = () => db.workstreams.find(w => w.name === 'main')?.branch;
const keysSent = () => state.sent.filter(s => s.type === 'tmux-send-keys').map(s => String(s.payload.keys));
const types = () => state.sent.map(s => s.type);

function connect(capabilities: string[]) {
  state.agent = { capabilities, helloReceived: true };
  return { instance: db.instances[0], user, agentCommit: null, capabilities, settled: Promise.resolve() };
}

async function createWidget(extra: Record<string, unknown> = {}) {
  return createProjectFor(user, {
    name: 'widget', instanceId: 'box1', initialAgent: { enabled: true, provider: 'claude' }, repoUrl: WIDGET, ...extra,
  });
}

function report(attempt: number, status: string, more: Record<string, unknown> = {}) {
  return { kind: 'report' as const, attempt, report: { status, ...more } as any };
}

describe('a repo pick on a box', () => {
  it('on a cold box answers 201 pending and sends nothing', async () => {
    const result = await createWidget({ defaultBranch: 'develop' });

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ name: 'widget', setupStatus: 'pending', repoUrl: WIDGET });
    expect(state.sent).toEqual([]);
    expect(db.workflows).toEqual([expect.objectContaining({ type: 'agent', provider: 'claude' })]);
    expect(mainBranch()).toBe('develop');
  });

  it('waits for a connected agent that has not said hello, as it may still clone durably', async () => {
    state.agent = { capabilities: [], helloReceived: false };

    const result = await createWidget();

    expect(result.body).toMatchObject({ setupStatus: 'pending' });
    expect(state.sent).toEqual([]);
  });

  it('a capable hello sends exactly one project-clone and creates no session', async () => {
    await createWidget({ defaultBranch: 'develop' });

    await redispatchClones(connect(CAPABLE));

    expect(state.sent).toEqual([{
      type: 'project-clone',
      payload: { projectId: 'p1', instanceId: 'box1', dir: DIR, url: WIDGET, branch: 'develop', attempt: 0, sizeKb: null },
    }]);
    expect(project().setupStatus).toBe('pending');
  });

  it('a capable hello sets a pending project with no repository up empty, cloning nothing', async () => {
    await createWidget();
    project().repoUrl = null;

    await redispatchClones(connect(CAPABLE));

    expect(project().setupStatus).toBe('none');
    expect(state.sent.map(s => s.type)).not.toContain('project-clone');
    expect(state.sent.map(s => s.type)).toContain('mkdir');
  });

  it('dispatches a known template with its baked clone as the reference', async () => {
    await createProjectFor(user, {
      name: 'termag', instanceId: 'box1', initialAgent: { enabled: true, provider: 'claude' },
      repoUrl: 'https://github.com/psecor/termag.git',
    });

    await redispatchClones(connect(CAPABLE));

    expect(state.sent).toEqual([{
      type: 'project-clone',
      payload: {
        projectId: 'p1', instanceId: 'box1', dir: '/home/alice/termag/projects/termag', url: 'https://github.com/psecor/termag.git',
        branch: 'HEAD', attempt: 0, sizeKb: null, referenceDir: '/home/alice/src/termag',
      },
    }]);
  });

  it('dispatches during the create when the capable agent is already connected', async () => {
    connect(CAPABLE);

    const result = await createWidget();

    expect(result.body).toMatchObject({ setupStatus: 'pending' });
    expect(types()).toEqual(['project-clone']);
  });

  it('an incapable hello types the pane checkout once and leaves the project none', async () => {
    await createWidget();

    await redispatchClones(connect([]));

    expect(keysSent()).toHaveLength(1);
    expect(keysSent()[0]).toContain('GIT_CONFIG_GLOBAL=/dev/null git fetch --progress origin');
    expect(keysSent()[0]).toContain('&& claude');
    expect(types()).toEqual(['tmux-create', 'tmux-create', 'tmux-foreground-cmd', 'tmux-send-keys']);
    expect(project().setupStatus).toBe('none');
  });

  it('two incapable hellos at once type the clone once, even before the pane shows it', async () => {
    await createWidget();
    const ev = connect([]);
    state.paneLags = true;

    await Promise.all([redispatchClones(ev), redispatchClones(ev)]);

    expect(keysSent().filter(k => k.includes('git fetch'))).toHaveLength(1);
    expect(project().setupStatus).toBe('none');
  });

  it('an incapable hello whose probe cannot tell fails the project, and a retry types the checkout', async () => {
    await createWidget();
    state.probeFails = true;

    await redispatchClones(connect([]));

    expect(project()).toMatchObject({
      setupStatus: 'failed',
      setupError: "The box's agent did not say whether the terminal was free, so the checkout was not typed. Retry it or start empty.",
    });
    expect(keysSent()).toEqual([]);

    state.probeFails = false;
    expect(await retryCloneFor(user, 'p1')).toEqual({ status: 202, body: { setupStatus: 'none' } });

    expect(keysSent()).toHaveLength(1);
    expect(keysSent()[0]).toContain('git fetch --progress origin');
    expect(keysSent()[0]).toContain('&& claude');
    expect(project()).toMatchObject({ setupStatus: 'none', setupAttempt: 1, setupError: null });
  });

  it('an incapable hello fails a project whose agent was removed, and start empty recovers it', async () => {
    await createWidget();
    db.workflows = [];

    await redispatchClones(connect([]));

    expect(project()).toMatchObject({
      setupStatus: 'failed',
      setupError: 'This project has no agent to run the checkout in. Start it empty.',
    });
    expect(state.sent).toEqual([]);

    const result = await startEmptyFor(user, 'p1');

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ id: 'p1', setupStatus: 'none', repoUrl: null, setupError: null });
    expect(types()).toEqual(['mkdir', 'init-wiki']);
  });

  it('reconstruction while the project waits creates no session for it', async () => {
    await createWidget();
    connect(CAPABLE);

    await reconstructInstanceSessions('box1', 'u1', 'alice');

    expect(state.sent).toEqual([]);
  });
});

describe('what the box reports', () => {
  beforeEach(async () => {
    await createWidget();
    await redispatchClones(connect(CAPABLE));
    state.sent = [];
  });

  it('ready launches the agent once, records the branch, and a replayed ready does nothing', async () => {
    expect(await applySetupEvent({ projectId: 'p1', instanceId: 'box1' }, report(0, 'cloning'))).toEqual({
      kind: 'applied', from: 'pending', to: 'cloning',
    });
    expect(await applySetupEvent({ projectId: 'p1', instanceId: 'box1' }, report(0, 'ready', { branch: 'trunk' })))
      .toEqual({ kind: 'applied', from: 'cloning', to: 'ready' });
    expect(await applySetupEvent({ projectId: 'p1', instanceId: 'box1' }, report(0, 'ready', { branch: 'trunk' })))
      .toEqual({ kind: 'ignored', why: 'report-ready while ready' });

    expect(keysSent()).toEqual(['claude']);
    expect(project()).toMatchObject({ setupStatus: 'ready', repoDefaultBranch: 'trunk', setupError: null });
    expect(mainBranch()).toBe('trunk');
  });

  it('commits a ready whose launch probe cannot tell, with the sessions made and the agent untyped', async () => {
    await applySetupEvent({ projectId: 'p1', instanceId: 'box1' }, report(0, 'cloning'));
    state.probeFails = true;

    expect(await applySetupEvent({ projectId: 'p1', instanceId: 'box1' }, report(0, 'ready', { branch: 'trunk' })))
      .toEqual({ kind: 'applied', from: 'cloning', to: 'ready' });

    expect(state.sent).toEqual([
      { type: 'tmux-create', payload: { sessionName: 'alice-widget-agent', cwd: DIR } },
      { type: 'tmux-create', payload: { sessionName: 'alice-widget-ctrl', cwd: DIR } },
      { type: 'tmux-foreground-cmd', payload: { sessionName: 'alice-widget-agent' } },
    ]);
    expect(keysSent()).toEqual([]);
    expect(project()).toMatchObject({ setupStatus: 'ready', repoDefaultBranch: 'trunk' });
    expect(mainBranch()).toBe('trunk');
  });

  it('a failure is recorded with its message', async () => {
    await applySetupEvent({ projectId: 'p1', instanceId: 'box1' }, report(0, 'failed', { error: 'Repository not found' }));

    expect(project()).toMatchObject({ setupStatus: 'failed', setupError: 'Repository not found' });
    expect(state.sent).toEqual([]);
  });

  describe('frames that change nothing', () => {
    let deliver: (instanceId: string, msg: Record<string, unknown>) => Promise<void>;

    beforeEach(() => {
      helloListeners.length = 0;
      frameListeners.length = 0;
      startProjectClone();
      deliver = async (instanceId, msg) => {
        frameListeners[0]({ instance: db.instances.find(i => i.id === instanceId), user, msg });
        await new Promise(r => setTimeout(r, 20));
      };
    });

    const ready = (instanceId: string, attempt = 0) => ({
      type: 'project-clone-status', projectId: 'p1', instanceId, attempt, status: 'ready', branch: 'trunk',
    });

    it('for an archived project', async () => {
      project().archived = true;
      await deliver('box1', ready('box1'));
      expect(project()).toMatchObject({ setupStatus: 'pending', archived: true });
      expect(state.sent).toEqual([]);
    });

    it('from another box, whether it names its own box or the project one', async () => {
      await deliver('box2', ready('box1'));
      await deliver('box2', ready('box2'));
      expect(project().setupStatus).toBe('pending');
      expect(state.sent).toEqual([]);
    });

    it('after the owner started the project empty', async () => {
      await applySetupEvent({ projectId: 'p1', instanceId: 'box1' }, report(0, 'failed', { error: 'boom' }));
      await startEmptyFor(user, 'p1');
      state.sent = [];
      await deliver('box1', ready('box1'));
      expect(project()).toMatchObject({ setupStatus: 'none', repoUrl: null });
      expect(state.sent).toEqual([]);
    });

    it('from an earlier attempt', async () => {
      await applySetupEvent({ projectId: 'p1', instanceId: 'box1' }, report(0, 'failed', { error: 'boom' }));
      await retryCloneFor(user, 'p1');
      state.sent = [];
      await deliver('box1', ready('box1', 0));
      expect(project()).toMatchObject({ setupStatus: 'pending', setupAttempt: 1 });
      expect(state.sent).toEqual([]);
    });

    it('when the frame is unreadable', async () => {
      await deliver('box1', { type: 'project-clone-status', projectId: 'p1', instanceId: 'box1', status: 'ready' });
      expect(project().setupStatus).toBe('pending');
      expect(state.sent).toEqual([]);
    });
  });

  it('a frame through the listener moves the project', async () => {
    helloListeners.length = 0;
    frameListeners.length = 0;
    startProjectClone();
    frameListeners[0]({
      instance: db.instances[0], user,
      msg: { type: 'project-clone-status', projectId: 'p1', instanceId: 'box1', attempt: 0, status: 'cloning' },
    });
    await vi.waitFor(() => expect(project().setupStatus).toBe('cloning'));
  });
});

describe('the replay the create came from', () => {
  const RID = 'huuhcqcev124emZ9urmRjjPSNXLl';
  const target = { projectId: 'p1', instanceId: 'box1' };

  it('rides on the row to the deferred launch, which types it when the box can print it, then clears it', async () => {
    await createWidget({ replaySessionId: RID });
    expect(project().launchReplaySessionId).toBe(RID);
    await redispatchClones(connect([...CAPABLE, 'telemetry-replay-v1']));
    await applySetupEvent(target, report(0, 'cloning'));
    expect(project().launchReplaySessionId).toBe(RID);

    expect(await applySetupEvent(target, report(0, 'ready', { branch: 'trunk' }))).toEqual({ kind: 'applied', from: 'cloning', to: 'ready' });
    expect(keysSent()).toEqual([`claude --settings "$(termag-credentials telemetry-launch ${RID})"`]);
    expect(project()).toMatchObject({ setupStatus: 'ready', launchReplaySessionId: null });
  });

  it('is dropped unless it is a replay id, and an older box gets the bare launch', async () => {
    await createWidget({ replaySessionId: `${RID};id` });
    expect(project().launchReplaySessionId).toBeNull();
    db.projects = [];

    await createWidget({ replaySessionId: RID });
    await redispatchClones(connect(CAPABLE));
    await applySetupEvent(target, report(0, 'cloning'));
    await applySetupEvent(target, report(0, 'ready', { branch: 'trunk' }));
    expect(keysSent()).toEqual(['claude']);
    expect(project().launchReplaySessionId).toBeNull();
  });

  it('is cleared with a ready whose probe left the agent untyped: the reconnect resume is bare', async () => {
    await createWidget({ replaySessionId: RID });
    await redispatchClones(connect([...CAPABLE, 'telemetry-replay-v1']));
    await applySetupEvent(target, report(0, 'cloning'));
    state.probeFails = true;
    // The probe could not tell, so nothing was typed; the move still commits,
    // and nothing in setup types this launch again.
    expect(await applySetupEvent(target, report(0, 'ready', { branch: 'trunk' }))).toEqual({ kind: 'applied', from: 'cloning', to: 'ready' });
    expect(keysSent()).toEqual([]);
    expect(project().launchReplaySessionId).toBeNull();
  });
});

describe('retry and start empty', () => {
  beforeEach(async () => {
    await createWidget();
    await redispatchClones(connect(CAPABLE));
    await applySetupEvent({ projectId: 'p1', instanceId: 'box1' }, report(0, 'failed', { error: 'boom' }));
    state.sent = [];
  });

  it('retry sends a failed project back to pending as a new attempt, and dispatches it', async () => {
    const result = await retryCloneFor(user, 'p1');

    expect(result).toEqual({ status: 202, body: { setupStatus: 'pending' } });
    expect(project()).toMatchObject({ setupStatus: 'pending', setupAttempt: 1, setupError: null });
    expect(state.sent).toEqual([{
      type: 'project-clone',
      payload: { projectId: 'p1', instanceId: 'box1', dir: DIR, url: WIDGET, branch: 'HEAD', attempt: 1, sizeKb: null },
    }]);
  });

  it('retry with no agent connected leaves the dispatch to the next hello', async () => {
    state.agent = null;

    expect(await retryCloneFor(user, 'p1')).toEqual({ status: 202, body: { setupStatus: 'pending' } });
    expect(state.sent).toEqual([]);
  });

  it('retry refuses a project that did not fail', async () => {
    await retryCloneFor(user, 'p1');
    await applySetupEvent({ projectId: 'p1', instanceId: 'box1' }, report(1, 'ready', { branch: 'trunk' }));
    state.sent = [];

    expect(await retryCloneFor(user, 'p1')).toEqual({ status: 409, body: { error: 'Only a failed clone can be retried.' } });
    expect(project()).toMatchObject({ setupStatus: 'ready', setupAttempt: 1 });
    expect(state.sent).toEqual([]);
  });

  it('start empty makes the dir, launches the agent and forgets the repository', async () => {
    const result = await startEmptyFor(user, 'p1');

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ id: 'p1', setupStatus: 'none', repoUrl: null, repoDefaultBranch: null, setupError: null });
    expect(mainBranch()).toBe('main');
    expect(state.sent.slice(0, 2)).toEqual([
      { type: 'mkdir', payload: { dir: DIR } },
      { type: 'init-wiki', payload: { dir: DIR, slug: 'widget', username: 'alice' } },
    ]);
    expect(types().slice(2)).toEqual(['tmux-create', 'tmux-create', 'tmux-foreground-cmd', 'tmux-send-keys']);
    expect(keysSent()).toEqual(['claude']);
  });

  it('start empty needs the box agent', async () => {
    state.agent = null;

    expect(await startEmptyFor(user, 'p1')).toEqual({ status: 503, body: { error: 'Box agent is not connected' } });
    expect(project().setupStatus).toBe('failed');
  });

  it("answers 404 for another user's project", async () => {
    const other = { ...user, id: 'u2' } as Express.User;
    expect(await retryCloneFor(other, 'p1')).toEqual({ status: 404, body: { error: 'Project not found' } });
    expect(await startEmptyFor(other, 'p1')).toEqual({ status: 404, body: { error: 'Project not found' } });
  });
});

describe('a bridge provider', () => {
  beforeEach(() => { state.defaultProvider = 'codex'; });

  const createCodex = () => createProjectFor({ ...user, defaultAgentProvider: 'codex' } as Express.User, {
    name: 'widget', instanceId: 'box1', initialAgent: { enabled: true }, repoUrl: WIDGET,
  });

  it('on a cold box waits, then fails with the reason when the agent cannot clone durably', async () => {
    const result = await createCodex();
    expect(result.body).toMatchObject({ setupStatus: 'pending' });

    await redispatchClones(connect([]));

    expect(project()).toMatchObject({
      setupStatus: 'failed',
      setupError: "This box's agent can't clone a repository for Codex. Update the box or start empty.",
    });
    expect(state.sent).toEqual([]);
  });

  it('is accepted on a box whose agent clones durably', async () => {
    connect(CAPABLE);

    const result = await createCodex();

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ setupStatus: 'pending' });
    expect(types()).toEqual(['project-clone']);
  });

  it('is refused up front on a box whose agent can only use the pane', async () => {
    connect([]);

    expect(await createCodex()).toEqual({
      status: 400,
      body: { error: 'repoUrl is not supported with codex: pick a provider that launches in the pane' },
    });
    expect(db.projects).toEqual([]);
  });
});

describe('the listeners', () => {
  it('a hello redispatches the box projects once its delivery has settled', async () => {
    await createWidget();
    helloListeners.length = 0;
    frameListeners.length = 0;
    startProjectClone();

    let settle!: () => void;
    const ev = { ...connect(CAPABLE), settled: new Promise<void>(r => { settle = r; }) };
    helloListeners[0](ev);
    await new Promise(r => setTimeout(r, 20));
    expect(state.sent).toEqual([]);

    settle();
    await vi.waitFor(() => expect(types()).toEqual(['project-clone']));
  });
});
