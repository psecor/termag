import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Project, ProjectInvite, ProjectShareInfo, STATUS_EMOJI, AgentStatusValue, Instance } from '../types';
import { PROVIDERS, PROVIDER_IDS, providerForSource } from '../providers/registry';
import { useProjects } from '../contexts/ProjectContext';
import { useAuth } from '../contexts/AuthContext';
import { projectsApi, agentTokensApi, sharingApi, instancesApi, workstreamsApi, AgentTokenInfo } from '../services/api';
import { sessionName as buildSessionName } from '../utils/sessionName';

// Aggregate priority for combining per-workstream statuses into a single
// project-row signal: "is anything alive on this project?"
const STATUS_PRIORITY: Record<AgentStatusValue, number> = {
  working: 4,
  waiting: 3,
  idle: 2,
  not_running: 1,
};

// Deterministic hue from a box's instance id so a project's "which box" stripe
// stays the same across reloads. Fixed saturation/lightness keeps the visual
// weight consistent against the dark theme. Returns null for legacy projects
// (instanceId === null) so they render with no stripe.
function boxStripeColor(instanceId: string | null | undefined): string | null {
  if (!instanceId) return null;
  let h = 0;
  for (let i = 0; i < instanceId.length; i++) {
    h = (h * 31 + instanceId.charCodeAt(i)) >>> 0;
  }
  return `hsl(${h % 360}, 55%, 58%)`;
}

function ConfirmDialog({ message, onConfirm, onCancel }: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="confirm-backdrop" onClick={onCancel}>
      <div className="confirm-dialog" onClick={e => e.stopPropagation()}>
        <p className="confirm-message">{message}</p>
        <div className="confirm-actions">
          <button className="confirm-btn confirm-btn-cancel" onClick={onCancel}>Cancel</button>
          <button className="confirm-btn confirm-btn-confirm" onClick={onConfirm} autoFocus>Confirm</button>
        </div>
      </div>
    </div>
  );
}

export function ProjectControl() {
  const { user, logout, updateDefaultAgentProvider } = useAuth();
  const {
    projects, activeProjectId, statusMap, setActiveProject, reloadProjects,
    getActiveWorkstream, setActiveWorkstream,
  } = useProjects();
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectProvider, setNewProjectProvider] = useState(user?.defaultAgentProvider ?? 'codex');
  const [newProjectInstanceId, setNewProjectInstanceId] = useState<string>('');
  const [error, setError] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<{ message: string; onConfirm: () => void } | null>(null);
  const [projectFilter, setProjectFilter] = useState('');

  // Track status transitions for highlight flash
  const prevStatusRef = useRef<Record<string, AgentStatusValue>>({});
  const mountedAtRef = useRef(Date.now());
  // Map of project id → status it transitioned to (for coloring the flash)
  const [flashingProjects, setFlashingProjects] = useState<Map<string, AgentStatusValue>>(new Map());

  useEffect(() => {
    const prev = prevStatusRef.current;
    const newFlashes = new Map<string, AgentStatusValue>();
    // Skip flashes during initial WebSocket state sync (first 3s after mount)
    const settled = Date.now() - mountedAtRef.current > 3000;

    for (const p of projects) {
      // Track aggregate per-project (was per-session). Same flash UX, but the
      // project row reflects whichever workstream is most alive rather than
      // staying red while a non-main workstream does the work.
      const currentStatus = aggregateStatus(p);
      const prevStatus = prev[p.id];
      if (settled && prevStatus !== undefined && prevStatus !== currentStatus) {
        newFlashes.set(p.id, currentStatus);
      }
      prev[p.id] = currentStatus;
    }

    if (newFlashes.size > 0) {
      setFlashingProjects(f => {
        const merged = new Map(f);
        newFlashes.forEach((status, id) => merged.set(id, status));
        return merged;
      });
      const timer = setTimeout(() => {
        setFlashingProjects(f => {
          const next = new Map(f);
          newFlashes.forEach((_status, id) => next.delete(id));
          return next;
        });
      }, 15000);
      return () => clearTimeout(timer);
    }
  }, [statusMap, projects, user?.unixUsername]);

  // Sharing / invites
  const [invites, setInvites] = useState<ProjectInvite[]>([]);
  const [shareProjectId, setShareProjectId] = useState<string | null>(null);
  const [shareEmail, setShareEmail] = useState('');
  const [shares, setShares] = useState<ProjectShareInfo[]>([]);

  // Workstreams — branch-off inline form
  const [branchOffProjectId, setBranchOffProjectId] = useState<string | null>(null);
  const [newWorkstreamName, setNewWorkstreamName] = useState('');

  // Load pending invites on mount
  useEffect(() => {
    if (user) sharingApi.listInvites().then(data => {
      if (Array.isArray(data)) setInvites(data);
    }).catch(() => {});
  }, [user]);

  // Track which owned projects have active shares
  const [sharedProjectIds, setSharedProjectIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!user) return;
    const ownedProjects = projects.filter(p => p.role !== 'collaborator');
    Promise.all(ownedProjects.map(p =>
      sharingApi.listShares(p.id).then(data => Array.isArray(data) && data.length > 0 ? p.id : null).catch(() => null)
    )).then(results => {
      setSharedProjectIds(new Set(results.filter(Boolean) as string[]));
    });
  }, [projects, user]);

  // Load shares when share panel opens
  useEffect(() => {
    if (shareProjectId) {
      sharingApi.listShares(shareProjectId).then(data => {
        if (Array.isArray(data)) setShares(data); else setShares([]);
      }).catch(() => setShares([]));
    }
  }, [shareProjectId]);

  // Boxes (compute instances)
  const [boxes, setBoxes] = useState<Instance[]>([]);
  const [newBoxName, setNewBoxName] = useState('');
  const [newBoxSelfManaged, setNewBoxSelfManaged] = useState(false);
  const [boxError, setBoxError] = useState('');
  const [boxMenuOpenId, setBoxMenuOpenId] = useState<string | null>(null);
  // Set after creating a self-managed box: the one-time token + config to paste
  // into agent.config.json on the user's own machine.
  const [createdBox, setCreatedBox] = useState<{ name: string; token: string; agentWsUrl?: string } | null>(null);

  const reloadBoxes = useCallback(async () => {
    try { setBoxes(await instancesApi.list()); } catch { /* ignore */ }
  }, []);

  // Load boxes on mount.
  useEffect(() => {
    if (user) reloadBoxes();
  }, [user, reloadBoxes]);

  // Poll while any box is still coming up (EC2 provisioning, or an external box
  // awaiting its agent) so the spinner resolves to ready/failed without a manual
  // refresh.
  useEffect(() => {
    if (!boxes.some(b => b.status === 'provisioning' || b.status === 'awaiting-agent')) return;
    const id = setInterval(reloadBoxes, 5000);
    return () => clearInterval(id);
  }, [boxes, reloadBoxes]);

  // Agent tokens
  const [tokens, setTokens] = useState<AgentTokenInfo[]>([]);
  const [newTokenName, setNewTokenName] = useState('');
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [showTokens, setShowTokens] = useState(false);

  useEffect(() => {
    if (showTokens) {
      agentTokensApi.list().then(setTokens).catch(() => {});
    }
  }, [showTokens]);

  useEffect(() => {
    if (user?.defaultAgentProvider) {
      setNewProjectProvider(user.defaultAgentProvider);
    }
  }, [user?.defaultAgentProvider]);

  // List of all the agent tmux session names for a project, one per workstream
  // (with `main` collapsing to the historical 3-segment name). Falls back to
  // the historical single-session shape if workstreams haven't loaded yet.
  function projectAgentSessions(project: Project): string[] {
    const owner = project.ownerUsername ?? user?.unixUsername ?? '';
    const wsList = project.workstreams ?? [];
    if (wsList.length === 0) return [buildSessionName(owner, project.name, 'agent')];
    return wsList.map(ws => buildSessionName(owner, project.name, 'agent', ws.name));
  }

  // Project-row status aggregates across all workstreams: the worst-priority
  // signal wins, so a project flips to working/waiting whenever any of its
  // workstreams does. Per-workstream icons in the sub-list disambiguate which
  // one is actually doing the work.
  function aggregateStatus(project: Project): AgentStatusValue {
    if (!project.workflows.some(w => w.type === 'agent')) return 'not_running';
    let best: AgentStatusValue = 'not_running';
    for (const s of projectAgentSessions(project)) {
      const cur = statusMap[s]?.status ?? 'not_running';
      if (STATUS_PRIORITY[cur] > STATUS_PRIORITY[best]) best = cur;
    }
    return best;
  }

  function statusEmoji(project: Project): string {
    if (!project.workflows.some(w => w.type === 'agent')) return '—';
    return STATUS_EMOJI[aggregateStatus(project)];
  }

  function contextWarning(project: Project): { level: 'ok' | 'warn' | 'danger'; tokens: number } | null {
    if (!project.workflows.some(w => w.type === 'agent')) return null;
    // Take the worst (highest tokens) across workstreams — that's the one
    // about to bite.
    let max = 0;
    for (const s of projectAgentSessions(project)) {
      const t = statusMap[s]?.contextTokens;
      if (t && t > max) max = t;
    }
    if (max < 500_000) return null;
    return { level: max >= 1_000_000 ? 'danger' : 'warn', tokens: max };
  }

  function rateLimitWarning(project: Project): string | null {
    if (!project.workflows.some(w => w.type === 'agent')) return null;
    for (const s of projectAgentSessions(project)) {
      const r = statusMap[s]?.rateLimited;
      if (r) return r;
    }
    return null;
  }

  function fmtTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    return `${Math.round(n / 1000)}K`;
  }

  function persistedAgentProvider(project: Project): string | null {
    return project.workflows.find(w => w.type === 'agent')?.provider ?? null;
  }

  function displayAgentProvider(project: Project): string | null {
    // Pick up the live `source` from any workstream's status (the first
    // that has one), so the badge reflects the actually-running provider
    // when a project has mixed setups. Falls back to the persisted value.
    for (const s of projectAgentSessions(project)) {
      const source = statusMap[s]?.source;
      if (source) {
        const fromSource = providerForSource(source);
        if (fromSource) return fromSource;
      }
    }
    return persistedAgentProvider(project);
  }

  async function acceptInvite(inviteId: string) {
    try {
      await sharingApi.acceptInvite(inviteId);
      setInvites(prev => prev.filter(i => i.id !== inviteId));
      await reloadProjects();
    } catch { setError('Failed to accept invite'); }
  }

  async function declineInvite(inviteId: string) {
    try {
      await sharingApi.declineInvite(inviteId);
      setInvites(prev => prev.filter(i => i.id !== inviteId));
    } catch { setError('Failed to decline invite'); }
  }

  async function sendInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!shareProjectId || !shareEmail.trim()) return;
    try {
      await sharingApi.invite(shareProjectId, shareEmail.trim());
      setShareEmail('');
      setError('');
      // Refresh shares list
      const updated = await sharingApi.listShares(shareProjectId);
      setShares(updated);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || 'Failed to send invite');
    }
  }

  async function revokeShare(shareId: string) {
    if (!shareProjectId) return;
    try {
      await sharingApi.revokeShare(shareProjectId, shareId);
      const remaining = shares.filter(s => s.id !== shareId);
      setShares(remaining);
      if (remaining.length === 0) {
        setSharedProjectIds(prev => { const next = new Set(prev); next.delete(shareProjectId!); return next; });
      }
    } catch { setError('Failed to revoke share'); }
  }

  function leaveProject(projectId: string) {
    setConfirmState({
      message: 'Leave this shared project?',
      onConfirm: async () => {
        try {
          await sharingApi.leaveProject(projectId);
          if (activeProjectId === projectId) setActiveProject(null);
          await reloadProjects();
        } catch { setError('Failed to leave project'); }
      },
    });
  }

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    if (!newProjectName.trim()) return;
    try {
      const project = await projectsApi.create({
        name: newProjectName.trim(),
        instanceId: newProjectInstanceId || null,
        initialAgent: { enabled: true, provider: newProjectProvider },
      });
      setNewProjectName('');
      setError('');
      await reloadProjects();
      setActiveProject(project.id);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || 'Failed to create project');
    }
  }

  async function renameProject(project: Project) {
    const newName = renameValue.trim();
    if (!newName || newName === project.name) { setRenamingId(null); return; }
    try {
      await projectsApi.rename(project.id, newName);
      setRenamingId(null);
      setRenameValue('');
      await reloadProjects();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || 'Failed to rename project');
      setRenamingId(null);
    }
  }

  function archiveProject(project: Project) {
    setConfirmState({
      message: `Archive ${project.name}? This will kill all tmux sessions for this project.`,
      onConfirm: async () => {
        await projectsApi.archive(project.id);
        if (activeProjectId === project.id) setActiveProject(null);
        await reloadProjects();
      },
    });
  }

  async function togglePin(project: Project) {
    await projectsApi.togglePin(project.id);
    await reloadProjects();
  }

  async function createWorkstream(e: React.FormEvent, projectId: string) {
    e.preventDefault();
    const name = newWorkstreamName.trim();
    if (!name) return;
    try {
      const ws = await workstreamsApi.create(projectId, { name });
      setNewWorkstreamName('');
      setBranchOffProjectId(null);
      await reloadProjects();
      // Auto-switch to the freshly-created workstream — branching off without
      // jumping to the new line feels wrong.
      setActiveWorkstream(projectId, ws.name);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } }).response?.data?.error;
      setError(msg ?? 'Failed to create workstream');
    }
  }

  function deleteWorkstream(project: Project, ws: { id: string; name: string }) {
    setConfirmState({
      message: `Delete workstream "${ws.name}"? Removes the worktree and its branch (refuses on unmerged work).`,
      onConfirm: async () => {
        try {
          const result = await workstreamsApi.remove(project.id, ws.id);
          if (result.branchDeleteWarning) {
            setError(`Workstream removed, but branch cleanup warned: ${result.branchDeleteWarning}`);
          }
          if (getActiveWorkstream(project.id) === ws.name) {
            setActiveWorkstream(project.id, 'main');
          }
          await reloadProjects();
        } catch (err: unknown) {
          const msg = (err as { response?: { data?: { error?: string } } }).response?.data?.error;
          setError(msg ?? 'Failed to delete workstream');
        }
      },
    });
  }

  async function createBox(e: React.FormEvent) {
    e.preventDefault();
    if (!newBoxName.trim()) return;
    try {
      const result = await instancesApi.create(newBoxName.trim(), newBoxSelfManaged ? 'external' : 'ec2');
      // Self-managed boxes return a one-time token to paste into the agent
      // config on the user's own machine. EC2 boxes provision server-side.
      if (newBoxSelfManaged && result.token) {
        setCreatedBox({ name: result.instance.name, token: result.token, agentWsUrl: result.agentWsUrl });
      }
      setNewBoxName('');
      setNewBoxSelfManaged(false);
      setBoxError('');
      await reloadBoxes();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setBoxError(msg || 'Failed to create box');
    }
  }

  function terminateBox(box: Instance) {
    const doTerminate = async (confirmed: boolean) => {
      try {
        await instancesApi.terminate(box.id, confirmed);
        await reloadBoxes();
      } catch (err: unknown) {
        // 409 → box has live projects; re-confirm to archive them all.
        const resp = (err as { response?: { status?: number; data?: { projects?: Array<{ name: string }> } } })?.response;
        if (resp?.status === 409) {
          const names = (resp.data?.projects ?? []).map(p => p.name).join(', ');
          setConfirmState({
            message: `"${box.name}" has live projects (${names}). Terminate anyway? This archives them all.`,
            onConfirm: () => doTerminate(true),
          });
        } else {
          setBoxError('Failed to terminate box');
        }
      }
    };
    setConfirmState({
      message: box.kind === 'external'
        ? `Remove box "${box.name}"? This revokes its token; stop the agent on that machine.`
        : `Terminate box "${box.name}"? This destroys the EC2 instance.`,
      onConfirm: () => doTerminate(false),
    });
  }

  async function createToken(e: React.FormEvent) {
    e.preventDefault();
    if (!newTokenName.trim()) return;
    try {
      const result = await agentTokensApi.create(newTokenName.trim());
      setCreatedToken(result.token);
      setNewTokenName('');
      const updated = await agentTokensApi.list();
      setTokens(updated);
    } catch {
      setError('Failed to create token');
    }
  }

  function revokeToken(id: string) {
    setConfirmState({
      message: 'Revoke this token? The agent using it will be disconnected.',
      onConfirm: async () => {
        await agentTokensApi.revoke(id);
        setTokens(prev => prev.filter(t => t.id !== id));
      },
    });
  }

  async function saveDefaultAgent(provider: string) {
    try {
      await updateDefaultAgentProvider(provider);
      setNewProjectProvider(provider);
      setError('');
    } catch {
      setError('Failed to save default agent');
    }
  }

  function renderProjectItem(p: typeof projects[0]) {
    const provider = displayAgentProvider(p);
    const config = provider ? PROVIDERS[provider] : null;
    const ctxWarn = contextWarning(p);
    const rateLimit = rateLimitWarning(p);
    const stripe = boxStripeColor(p.instanceId);
    const box = p.instanceId ? boxes.find(b => b.id === p.instanceId) : null;
    const wsCount = p.workstreams?.length ?? 0;
    return (
      <li
        key={p.id}
        className={`project-item ${activeProjectId === p.id ? 'active' : ''} ${flashingProjects.has(p.id) ? `status-flash-${flashingProjects.get(p.id)}` : ''} ${rateLimit ? 'rate-limited' : ''}`}
        style={stripe ? ({ ['--box-stripe' as any]: stripe } as React.CSSProperties) : undefined}
        title={box ? `box: ${box.name}` : undefined}
        onClick={() => setActiveProject(p.id)}
      >
        <span className="project-status">
          {statusEmoji(p)}
          {rateLimit ? (
            <span className="rate-limit-badge" title={rateLimit} />
          ) : ctxWarn && (
            <span
              className={`ctx-warn ctx-warn-${ctxWarn.level}`}
              title={`Context: ${fmtTokens(ctxWarn.tokens)} — consider /clear`}
            />
          )}
        </span>
        {renamingId === p.id ? (
          <input
            className="project-rename-input"
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onBlur={() => renameProject(p)}
            onKeyDown={e => {
              if (e.key === 'Enter') renameProject(p);
              if (e.key === 'Escape') setRenamingId(null);
            }}
            onClick={e => e.stopPropagation()}
            autoFocus
          />
        ) : (
          <>
            <span
              className="project-name"
              onDoubleClick={p.role !== 'collaborator' ? (e => {
                e.stopPropagation();
                setRenamingId(p.id);
                setRenameValue(p.name);
              }) : undefined}
            >
              {p.name}
              {p.role === 'collaborator' && (
                <span className="shared-label" title={`Shared by ${p.ownerUsername}`}>
                  {` (${p.ownerUsername})`}
                </span>
              )}
            </span>
            {wsCount > 1 && (
              <span
                className="project-workstream-count"
                title={`${wsCount} workstreams`}
              >↳{wsCount}</span>
            )}
            {config && (
              <span
                className="project-provider-badge"
                style={{
                  borderColor: config.color.bright.replace(/[\d.]+\)$/, '0.45)'),
                  background: config.color.base.replace(/[\d.]+\)$/, '0.16)'),
                }}
                title={`runtime: ${config.displayName}${persistedAgentProvider(p) ? `, saved: ${persistedAgentProvider(p)}` : ''}`}
              >
                {config.badge}
              </span>
            )}
          </>
        )}
        <span className="project-actions" onClick={e => e.stopPropagation()}>
          <button
            className="btn-tiny btn-overflow"
            onClick={() => setMenuOpenId(menuOpenId === p.id ? null : p.id)}
          >⋮</button>
          {menuOpenId === p.id && (
            <div className="project-menu" onMouseLeave={() => setMenuOpenId(null)}>
              {p.role === 'collaborator' ? (
                <button onClick={() => { leaveProject(p.id); setMenuOpenId(null); }}>Leave project</button>
              ) : (
                <>
                  <button onClick={() => { togglePin(p); setMenuOpenId(null); }}>
                    {p.pinned ? '◆ Unpin' : '◇ Pin to top'}
                  </button>
                  <button onClick={() => { setRenamingId(p.id); setRenameValue(p.name); setMenuOpenId(null); }}>
                    Rename
                  </button>
                  <button onClick={() => { setShareProjectId(shareProjectId === p.id ? null : p.id); setMenuOpenId(null); }}>
                    {sharedProjectIds.has(p.id) ? '● Sharing' : 'Share'}
                  </button>
                  <button onClick={() => {
                    setBranchOffProjectId(branchOffProjectId === p.id ? null : p.id);
                    setNewWorkstreamName('');
                    setMenuOpenId(null);
                  }}>
                    Branch off…
                  </button>
                  <button className="menu-danger" onClick={() => { archiveProject(p); setMenuOpenId(null); }}>
                    Archive
                  </button>
                </>
              )}
            </div>
          )}
        </span>
      </li>
    );
  }

  return (
    <div className="project-control">
      <div className="project-control-header">
        <span className="project-control-title">termag</span>
        <button className="btn-ghost" onClick={logout}>sign out</button>
      </div>

      {error && <div className="error-banner">{error}<button onClick={() => setError('')}>×</button></div>}

      {invites.length > 0 && (
        <section className="control-section invite-section">
          <h3>Invites</h3>
          <ul className="invite-list">
            {invites.map(inv => (
              <li key={inv.id} className="invite-item">
                <span className="invite-info">
                  <strong>{inv.projectName}</strong> from {inv.inviterName}
                </span>
                <span className="invite-actions">
                  <button className="btn-tiny btn-success" onClick={() => acceptInvite(inv.id)}>accept</button>
                  <button className="btn-tiny btn-danger" onClick={() => declineInvite(inv.id)}>decline</button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="control-section">
        <h3>Projects</h3>
        {projects.length > 5 && (
          <input
            className="project-filter"
            type="text"
            placeholder="Filter…"
            value={projectFilter}
            onChange={e => setProjectFilter(e.target.value)}
          />
        )}
        <ul className="project-list">
          {(() => {
            const filtered = projectFilter
              ? projects.filter(p => p.name.toLowerCase().includes(projectFilter.toLowerCase()))
              : projects;

            // Render one project: its row, an optional branch-off form, and any
            // workstream sub-rows. Hoisted so each box group can reuse it.
            const renderRow = (p: typeof projects[0]) => {
              const branchingOff = branchOffProjectId === p.id;
              const showWorkstreams = p.workstreams.length > 1;
              const activeWs = getActiveWorkstream(p.id);
              const owner = p.ownerUsername ?? user?.unixUsername ?? '';
              return (
                <React.Fragment key={p.id}>
                  {renderProjectItem(p)}
                  {branchingOff && (
                    <li className="project-workstream-branch-off">
                      <form
                        className="inline-form"
                        onSubmit={e => createWorkstream(e, p.id)}
                        onClick={e => e.stopPropagation()}
                      >
                        <input
                          autoFocus
                          value={newWorkstreamName}
                          onChange={e => setNewWorkstreamName(e.target.value)}
                          placeholder="workstream name (also branch)"
                        />
                        <button type="submit" title="Branch off">+</button>
                        <button
                          type="button"
                          className="btn-tiny"
                          onClick={() => { setBranchOffProjectId(null); setNewWorkstreamName(''); }}
                        >×</button>
                      </form>
                    </li>
                  )}
                  {showWorkstreams && p.workstreams.map(ws => {
                    const wsSession = buildSessionName(owner, p.name, 'agent', ws.name);
                    const wsHasAgent = p.workflows.some(
                      w => w.workstreamId === ws.id && w.type === 'agent',
                    );
                    const wsStatus = statusMap[wsSession]?.status ?? 'not_running';
                    return (
                      <li
                        key={ws.id}
                        className={`project-workstream-item ${activeProjectId === p.id && activeWs === ws.name ? 'active' : ''}`}
                        onClick={() => { setActiveProject(p.id); setActiveWorkstream(p.id, ws.name); }}
                        title={`branch: ${ws.branch}`}
                      >
                        <span className="workstream-status">
                          {wsHasAgent ? STATUS_EMOJI[wsStatus] : '—'}
                        </span>
                        <span className="workstream-marker">↳</span>
                        <span className="workstream-name">{ws.name}</span>
                        {ws.name !== 'main' && p.role !== 'collaborator' && (
                          <span className="project-actions" onClick={e => e.stopPropagation()}>
                            <button
                              className="btn-tiny btn-danger"
                              onClick={() => deleteWorkstream(p, ws)}
                              title="Delete workstream"
                            >×</button>
                          </span>
                        )}
                      </li>
                    );
                  })}
                </React.Fragment>
              );
            };

            // Pinned projects float to the top of their own box group.
            const sortPinned = (arr: typeof projects) => [
              ...arr.filter(p => p.pinned),
              ...arr.filter(p => !p.pinned),
            ];

            // Group projects by box: one group per box that has projects (sorted
            // by box name), then collaborator projects on boxes I don't own, then
            // legacy "this host" projects (no instance). Empty groups are hidden.
            const knownBoxIds = new Set(boxes.map(b => b.id));
            const groups: {
              key: string; label: string; color: string | null;
              dot?: string; rows: typeof projects;
            }[] = [];

            [...boxes].sort((a, b) => a.name.localeCompare(b.name)).forEach(b => {
              const rows = sortPinned(filtered.filter(p => p.instanceId === b.id));
              if (!rows.length) return;
              const pending = b.status === 'provisioning' || b.status === 'awaiting-agent';
              groups.push({
                key: b.id,
                label: b.name,
                color: boxStripeColor(b.id),
                dot: b.status === 'ready' ? 'var(--success)' : pending ? 'var(--warning)' : 'var(--danger)',
                rows,
              });
            });

            const shared = sortPinned(filtered.filter(p => p.instanceId && !knownBoxIds.has(p.instanceId)));
            if (shared.length) groups.push({ key: '__shared', label: 'Shared with me', color: null, rows: shared });

            const local = sortPinned(filtered.filter(p => !p.instanceId));
            if (local.length) groups.push({ key: '__local', label: 'This host', color: null, rows: local });

            return groups.map(g => (
              <React.Fragment key={g.key}>
                <li
                  className="project-group-header"
                  style={g.color ? ({ ['--box-stripe' as any]: g.color } as React.CSSProperties) : undefined}
                >
                  {g.dot && <span className="project-group-dot" style={{ background: g.dot }} />}
                  <span className="project-group-name" title={g.label}>{g.label}</span>
                  <span className="project-group-count">{g.rows.length}</span>
                </li>
                {g.rows.map(renderRow)}
              </React.Fragment>
            ));
          })()}
        </ul>
        <form className="inline-form project-create-form" onSubmit={createProject}>
          <input
            value={newProjectName}
            onChange={e => setNewProjectName(e.target.value)}
            placeholder="new project"
          />
          <select
            className="inline-form-select"
            value={newProjectProvider}
            onChange={e => setNewProjectProvider(e.target.value)}
            title="Agent provider"
          >
            {PROVIDER_IDS.map(pid => (
              <option key={pid} value={pid}>{PROVIDERS[pid].displayName}</option>
            ))}
          </select>
          {boxes.some(b => b.status === 'ready') && (
            <select
              className="inline-form-select"
              value={newProjectInstanceId}
              onChange={e => setNewProjectInstanceId(e.target.value)}
              title="Box (host)"
            >
              <option value="">this host</option>
              {boxes.filter(b => b.status === 'ready').map(b => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          )}
          <button type="submit">+</button>
        </form>

        {shareProjectId && (
          <div className="share-panel">
            <h4>Share: {projects.find(p => p.id === shareProjectId)?.name}</h4>
            <form className="inline-form" onSubmit={sendInvite}>
              <input
                value={shareEmail}
                onChange={e => setShareEmail(e.target.value)}
                placeholder="user email"
              />
              <button type="submit">invite</button>
            </form>
            {shares.length > 0 && (
              <ul className="share-list">
                {shares.map(s => (
                  <li key={s.id} className="share-item">
                    <span>{s.userName} ({s.unixUsername})</span>
                    <button className="btn-tiny btn-danger" onClick={() => revokeShare(s.id)}>revoke</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section className="control-section">
        <h3>Boxes</h3>
        {boxError && <div className="error-banner">{boxError}<button onClick={() => setBoxError('')}>×</button></div>}
        <ul className="box-list">
          {boxes.map(b => {
            const pending = b.status === 'provisioning' || b.status === 'awaiting-agent';
            const dotColor = b.status === 'ready' ? 'var(--success)'
              : pending ? 'var(--warning)'
              : 'var(--danger)';
            // Same deterministic hue projects use for their "which box" stripe
            // (b.id is the project's instanceId), so this box is color-matched
            // to the project rows running on it.
            const stripe = boxStripeColor(b.id);
            return (
              <li
                key={b.id}
                className="box-item"
                style={stripe ? ({ ['--box-stripe' as any]: stripe } as React.CSSProperties) : undefined}
              >
                <span
                  className={`box-status-dot ${pending ? 'box-spinning' : ''}`}
                  style={{ background: dotColor }}
                  title={b.status === 'failed' && b.provisioningError ? b.provisioningError : b.status}
                />
                <span className="box-name" title={b.hostname ?? undefined}>{b.name}</span>
                {b.kind === 'external' && <span className="box-kind-badge" title="self-managed host">self</span>}
                <span className="box-meta">
                  {b.status === 'provisioning' ? 'provisioning…'
                    : b.status === 'awaiting-agent' ? 'awaiting…'
                    : b.status === 'failed' ? 'failed'
                    : `${b._count?.projects ?? 0} proj`}
                </span>
                <span className="project-actions" onClick={e => e.stopPropagation()}>
                  <button
                    className="btn-tiny btn-overflow"
                    onClick={() => setBoxMenuOpenId(boxMenuOpenId === b.id ? null : b.id)}
                  >⋮</button>
                  {boxMenuOpenId === b.id && (
                    <div className="project-menu" onMouseLeave={() => setBoxMenuOpenId(null)}>
                      <button className="menu-danger" onClick={() => { terminateBox(b); setBoxMenuOpenId(null); }}>
                        Terminate
                      </button>
                    </div>
                  )}
                </span>
              </li>
            );
          })}
          {boxes.length === 0 && <li className="box-empty">No boxes yet</li>}
        </ul>

        {createdBox && (
          <div className="token-created">
            <div className="token-created-label">
              Self-managed box “{createdBox.name}” — add this to <code>agent.config.json</code> on that
              machine and start the termag agent (copy now, shown once):
            </div>
            <code className="token-value">{JSON.stringify(
              { termag_url: createdBox.agentWsUrl ?? 'wss://<your-orchestrator>/termag/ws/agent', token: createdBox.token },
              null, 2,
            )}</code>
            <button className="btn-tiny" onClick={() => {
              navigator.clipboard.writeText(JSON.stringify(
                { termag_url: createdBox.agentWsUrl ?? 'wss://<your-orchestrator>/termag/ws/agent', token: createdBox.token },
                null, 2,
              ));
              setCreatedBox(null);
            }}>Copy &amp; dismiss</button>
          </div>
        )}

        <form className="inline-form" onSubmit={createBox}>
          <input
            value={newBoxName}
            onChange={e => setNewBoxName(e.target.value)}
            placeholder={newBoxSelfManaged ? 'my machine' : 'new box'}
          />
          <button type="submit" title={newBoxSelfManaged ? 'Register self-managed box' : 'Add box (EC2)'}>+</button>
        </form>
        <label className="box-self-toggle" title="Run the agent on your own machine instead of provisioning an EC2 box">
          <input
            type="checkbox"
            checked={newBoxSelfManaged}
            onChange={e => setNewBoxSelfManaged(e.target.checked)}
          />
          self-managed (run agent on my own machine)
        </label>
      </section>

      <section className="control-section">
        <h3 className="clickable-header" onClick={() => setShowTokens(s => !s)}>
          Agent {showTokens ? '▾' : '▸'}
        </h3>
        {showTokens && (
          <>
            {createdToken && (
              <div className="token-created">
                <div className="token-created-label">New token (copy now — shown once):</div>
                <code className="token-value">{createdToken}</code>
                <button className="btn-tiny" onClick={() => {
                  navigator.clipboard.writeText(createdToken);
                  setCreatedToken(null);
                }}>Copy &amp; dismiss</button>
              </div>
            )}

            <ul className="token-list">
              {tokens.map(t => (
                <li key={t.id} className="token-item">
                  <span className="token-name">{t.name}</span>
                  <span className="token-prefix">{t.tokenPrefix}</span>
                  <button className="btn-tiny btn-danger" onClick={() => revokeToken(t.id)} title="Revoke">×</button>
                </li>
              ))}
              {tokens.length === 0 && <li className="token-empty">No active tokens</li>}
            </ul>
            <form className="inline-form" onSubmit={createToken}>
              <input
                value={newTokenName}
                onChange={e => setNewTokenName(e.target.value)}
                placeholder="token name"
              />
              <button type="submit">+</button>
            </form>
            <div className="inline-form" style={{ marginTop: 12 }}>
              <label htmlFor="default-agent-provider">Default agent</label>
              <select
                className="inline-form-select"
                id="default-agent-provider"
                value={user?.defaultAgentProvider ?? 'codex'}
                onChange={e => saveDefaultAgent(e.target.value)}
              >
                {PROVIDER_IDS.map(pid => (
                  <option key={pid} value={pid}>{PROVIDERS[pid].displayName}</option>
                ))}
              </select>
            </div>
          </>
        )}
      </section>
      {confirmState && createPortal(
        <ConfirmDialog
          message={confirmState.message}
          onConfirm={() => { setConfirmState(null); confirmState.onConfirm(); }}
          onCancel={() => setConfirmState(null)}
        />,
        document.body,
      )}
    </div>
  );
}
