import React, { useState, useEffect, useRef } from 'react';
import { Project, STATUS_EMOJI, AgentStatusValue } from '../types';
import { PROVIDERS, PROVIDER_IDS, providerForSource } from '../providers/registry';
import { useProjects } from '../contexts/ProjectContext';
import { useAuth } from '../contexts/AuthContext';
import { projectsApi, agentTokensApi, AgentTokenInfo } from '../services/api';

export function ProjectControl() {
  const { user, logout, updateDefaultAgentProvider } = useAuth();
  const { projects, activeProjectId, statusMap, setActiveProject, reloadProjects } = useProjects();
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectProvider, setNewProjectProvider] = useState(user?.defaultAgentProvider ?? 'codex');
  const [error, setError] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

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
      const session = `${user?.unixUsername}-${p.name}-agent`;
      const currentStatus = statusMap[session]?.status ?? 'not_running';
      const prevStatus = prev[session];
      if (settled && prevStatus !== undefined && prevStatus !== currentStatus) {
        newFlashes.set(p.id, currentStatus);
      }
      prev[session] = currentStatus;
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

  function agentSessionName(project: Project): string {
    return `${user?.unixUsername}-${project.name}-agent`;
  }

  function statusEmoji(project: Project): string {
    if (!project.workflows.some(w => w.type === 'agent')) return '—';
    const s = statusMap[agentSessionName(project)];
    return STATUS_EMOJI[s?.status ?? 'not_running'];
  }

  function persistedAgentProvider(project: Project): string | null {
    return project.workflows.find(w => w.type === 'agent')?.provider ?? null;
  }

  function displayAgentProvider(project: Project): string | null {
    const status = statusMap[agentSessionName(project)];
    if (status?.source) {
      const fromSource = providerForSource(status.source);
      if (fromSource) return fromSource;
    }
    return persistedAgentProvider(project);
  }

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    if (!newProjectName.trim()) return;
    try {
      const project = await projectsApi.create({
        name: newProjectName.trim(),
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

  async function archiveProject(project: Project) {
    if (!confirm(`Archive ${project.name}? This will kill all tmux sessions for this project.`)) return;
    await projectsApi.archive(project.id);
    if (activeProjectId === project.id) setActiveProject(null);
    await reloadProjects();
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

  async function revokeToken(id: string) {
    if (!confirm('Revoke this token? The agent using it will be disconnected.')) return;
    await agentTokensApi.revoke(id);
    setTokens(prev => prev.filter(t => t.id !== id));
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

  return (
    <div className="project-control">
      <div className="project-control-header">
        <span className="project-control-title">termag</span>
        <button className="btn-ghost" onClick={logout}>sign out</button>
      </div>

      {error && <div className="error-banner">{error}<button onClick={() => setError('')}>×</button></div>}

      <section className="control-section">
        <h3>Projects</h3>
        <ul className="project-list">
          {projects.map(p => {
            const provider = displayAgentProvider(p);
            const config = provider ? PROVIDERS[provider] : null;
            return (
              <li
                key={p.id}
                className={`project-item ${activeProjectId === p.id ? 'active' : ''} ${flashingProjects.has(p.id) ? `status-flash-${flashingProjects.get(p.id)}` : ''}`}
                onClick={() => setActiveProject(p.id)}
              >
                <span className="project-status">{statusEmoji(p)}</span>
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
                      onDoubleClick={e => {
                        e.stopPropagation();
                        setRenamingId(p.id);
                        setRenameValue(p.name);
                      }}
                    >{p.name}</span>
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
                  <button className="btn-tiny btn-danger" onClick={() => archiveProject(p)} title="Archive">×</button>
                </span>
              </li>
            );
          })}
        </ul>
        <form className="inline-form" onSubmit={createProject}>
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
          <button type="submit">+</button>
        </form>
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
    </div>
  );
}
