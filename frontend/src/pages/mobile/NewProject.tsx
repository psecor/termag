// New project from the phone: name, agent, box, and an
// optional repository to clone. Same payload as the Welcome wizard; the clone
// runs in the agent pane, so the conversation screen shows it happening.
import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useProjects } from '../../contexts/ProjectContext';
import { instancesApi, projectsApi, ProjectTemplateInfo } from '../../services/api';
import { PROVIDERS, SELECTABLE_PROVIDER_IDS } from '../../providers/registry';
import type { Instance } from '../../types';
import { nameFromRepo } from '../../utils/repoName';
import { boxLabel, pickDefaultBox, usableBoxes } from '../../mobile/newProject';
import { apiError } from './Sheet';

const NONE = '__none__';
const CUSTOM = '__custom__';

export function NewProject() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { reloadProjects } = useProjects();

  const [boxes, setBoxes] = useState<Instance[] | null>(null);
  const [boxId, setBoxId] = useState('');
  useEffect(() => {
    instancesApi.list().then(list => {
      setBoxes(list);
      const pick = pickDefaultBox(list);
      if (pick) setBoxId(pick.id);
    }).catch(() => setBoxes([]));
  }, []);
  // A box that is still coming up: poll so the Create button enables itself.
  const box = boxes?.find(b => b.id === boxId) ?? null;
  useEffect(() => {
    if (!box || box.status === 'ready') return;
    const t = setInterval(() => { instancesApi.list().then(setBoxes).catch(() => {}); }, 5000);
    return () => clearInterval(t);
  }, [box?.id, box?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const [templates, setTemplates] = useState<ProjectTemplateInfo[]>([]);
  const [templateId, setTemplateId] = useState(NONE);
  const [customUrl, setCustomUrl] = useState('');
  useEffect(() => { projectsApi.templates().then(setTemplates).catch(() => {}); }, []);
  const repoUrl = useMemo(
    () => templateId === CUSTOM ? customUrl.trim() : templateId === NONE ? '' : (templates.find(t => t.id === templateId)?.repoUrl ?? ''),
    [templateId, customUrl, templates],
  );

  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  useEffect(() => { if (!nameTouched) setName(repoUrl ? nameFromRepo(repoUrl) : ''); }, [repoUrl, nameTouched]);

  const [provider, setProvider] = useState('');
  useEffect(() => {
    if (user && !provider) setProvider(SELECTABLE_PROVIDER_IDS.includes(user.defaultAgentProvider) ? user.defaultAgentProvider : SELECTABLE_PROVIDER_IDS[0]);
  }, [user, provider]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ready = box?.status === 'ready';
  const canCreate = Boolean(name.trim()) && ready && !busy && (templateId !== CUSTOM || customUrl.trim().length > 0);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!canCreate || !box) return;
    setBusy(true); setError('');
    try {
      const p = await projectsApi.create({
        name: name.trim(),
        instanceId: box.id,
        initialAgent: { enabled: true, provider },
        repoUrl: repoUrl || null,
      });
      await reloadProjects().catch(() => {});
      navigate(`/m/p/${encodeURIComponent(p.id)}`, { replace: true });
    } catch (err) {
      setError(apiError(err, 'Could not create the project'));
      setBusy(false);
    }
  }

  const usable = usableBoxes(boxes ?? []);

  return (
    <div className="m-screen">
      <header className="m-header m-header-conv">
        <Link className="m-link m-back" to="/m" aria-label="Back to inbox">‹</Link>
        <div className="m-conv-title"><span className="m-conv-name">New project</span></div>
      </header>
      <form className="m-form m-scroll" onSubmit={create}>
        <label className="m-field">
          <span className="m-field-label">Repository</span>
          <select className="m-select" value={templateId} onChange={e => setTemplateId(e.target.value)}>
            <option value={NONE}>none — start empty</option>
            {templates.map(t => <option key={t.id} value={t.id}>{t.label} — {t.blurb}</option>)}
            <option value={CUSTOM}>custom — a GitHub repo URL</option>
          </select>
        </label>
        {templateId === CUSTOM && (
          <label className="m-field">
            <span className="m-field-label">Repo URL</span>
            <input className="m-text" type="url" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false}
              placeholder="https://github.com/org/repo" value={customUrl} onChange={e => setCustomUrl(e.target.value)} />
          </label>
        )}
        <label className="m-field">
          <span className="m-field-label">Name</span>
          <input className="m-text" type="text" autoCapitalize="off" autoCorrect="off" spellCheck={false} required
            placeholder="my-project" value={name} onChange={e => { setName(e.target.value); setNameTouched(true); }} />
        </label>
        <label className="m-field">
          <span className="m-field-label">Agent</span>
          <select className="m-select" value={provider} onChange={e => setProvider(e.target.value)}>
            {SELECTABLE_PROVIDER_IDS.map(id => <option key={id} value={id}>{PROVIDERS[id]?.displayName ?? id}</option>)}
          </select>
        </label>
        <label className="m-field">
          <span className="m-field-label">Box</span>
          <select className="m-select" value={boxId} onChange={e => setBoxId(e.target.value)} disabled={boxes == null}>
            {boxes == null && <option value="">Loading…</option>}
            {boxes != null && usable.length === 0 && <option value="">No usable box — add one from the full UI</option>}
            {usable.map(b => <option key={b.id} value={b.id}>{boxLabel(b)}</option>)}
          </select>
          {box && !ready && <span className="m-field-hint">This box is {box.status.replace(/-/g, ' ')}; Create enables when it is ready.</span>}
        </label>
        {error && <div className="m-form-error">{error}</div>}
        <button type="submit" className="m-primary" disabled={!canCreate}>{busy ? 'Creating…' : 'Create'}</button>
        <p className="m-form-note">
          The project starts with a <code>main</code> workstream and its agent pane. With a repository, the clone runs in that pane before the agent launches.
        </p>
      </form>
    </div>
  );
}
