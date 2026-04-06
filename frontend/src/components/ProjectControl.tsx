import React, { useState } from 'react';
import { Project, STATUS_EMOJI } from '../types';
import { useProjects } from '../contexts/ProjectContext';
import { useAuth } from '../contexts/AuthContext';
import { projectsApi } from '../services/api';

export function ProjectControl() {
  const { user, logout } = useAuth();
  const { projects, activeProjectId, statusMap, setActiveProject, reloadProjects } = useProjects();
  const [newProjectName, setNewProjectName] = useState('');
  const [error, setError] = useState('');

  function agentSessionName(project: Project): string {
    return `${user?.unixUsername}-${project.name}-agent`;
  }

  function statusEmoji(project: Project): string {
    if (!project.workflows.some(w => w.type === 'agent')) return '—';
    const s = statusMap[agentSessionName(project)];
    return STATUS_EMOJI[s?.status ?? 'not_running'];
  }

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    if (!newProjectName.trim()) return;
    try {
      const project = await projectsApi.create({ name: newProjectName.trim() });
      setNewProjectName('');
      setError('');
      await reloadProjects();
      // Auto-add agent workflow and select
      await projectsApi.addWorkflow(project.id, 'agent');
      await reloadProjects();
      setActiveProject(project.id);
    } catch {
      setError('Failed to create project');
    }
  }

  async function archiveProject(project: Project) {
    if (!confirm(`Archive ${project.name}? This will kill all tmux sessions for this project.`)) return;
    await projectsApi.archive(project.id);
    if (activeProjectId === project.id) setActiveProject(null);
    await reloadProjects();
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
          {projects.map(p => (
            <li
              key={p.id}
              className={`project-item ${activeProjectId === p.id ? 'active' : ''}`}
              onClick={() => setActiveProject(p.id)}
            >
              <span className="project-status">{statusEmoji(p)}</span>
              <span className="project-name">{p.name}</span>
              <span className="project-actions" onClick={e => e.stopPropagation()}>
                <button className="btn-tiny btn-danger" onClick={() => archiveProject(p)} title="Archive">×</button>
              </span>
            </li>
          ))}
        </ul>
        <form className="inline-form" onSubmit={createProject}>
          <input
            value={newProjectName}
            onChange={e => setNewProjectName(e.target.value)}
            placeholder="new project"
          />
          <button type="submit">+</button>
        </form>
      </section>
    </div>
  );
}
