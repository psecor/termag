// The Share dialog's "In your browser" delivery: the
// project's preview links, read once here, the form that publishes one, and
// the list of links and agents' requests under it.
// The full UI's Share dialog and the simple UI's Share tab both show it, as
// SharePreview's other delivery (components/ShareDialog.tsx).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useProjects } from '../contexts/ProjectContext';
import { useAuth } from '../contexts/AuthContext';
import { FLAGS, useFlag } from '../flags';
import { ensureLaunchPadSprite } from '../launchpad/sprite';
import { previewLinkError, previewLinksApi, type PreviewLinkRequestView, type PreviewLinkView, type PreviewLinksList as LinksAnswer } from '../services/previewLinksApi';
import { PublishPreviewLink } from './PublishPreviewLink';
import { PreviewLinksList } from './PreviewLinksList';
import './previewLinks.css';

export function PreviewLinksPanel({ projectId, workstream, onBusyChange }: { projectId: string; workstream: string; onBusyChange?: (busy: boolean) => void }) {
  const audiencesOn = useFlag(FLAGS.previewLinksLinkAudience, false);
  const { projects } = useProjects();
  const project = projects.find(p => p.id === projectId);
  const projectName = project?.name ?? '';
  const { user } = useAuth();
  // A request with no workstream id comes from the project's implicit main checkout (Devin, #1486).
  const workstreamName = useCallback((id: string | null) => (id ? project?.workstreams?.find(w => w.id === id)?.name ?? null : 'main'), [project]);
  // The server refuses to remove a link's creator or the project's owner; only the signed-in owner is known to be the latter here.
  const unremovable = useCallback((link: PreviewLinkView, userId: string) => userId === link.owner?.id || (project?.role === 'owner' && userId === user?.id), [project, user]);
  const [list, setList] = useState<LinksAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  // An agent's request being answered: the form publishes its port, with its id.
  const [answering, setAnswering] = useState<PreviewLinkRequestView | null>(null);
  useEffect(() => { void ensureLaunchPadSprite(); }, []);

  // Only the latest read is applied: an earlier, slower one can't bring back a row a later change ended (Bugbot, #1486).
  const reading = useRef(0);
  const reload = useCallback(() => {
    const seq = ++reading.current;
    previewLinksApi.list(projectId).then(
      l => { if (seq === reading.current) { setList(l); setError(null); } },
      err => { if (seq === reading.current) setError(previewLinkError(err)); },
    );
  }, [projectId]);
  useEffect(() => { reload(); }, [reload]);
  // A request no longer pending (declined here, or answered elsewhere) stops being answered (Bugbot, #1486).
  useEffect(() => {
    if (answering && list && !list.requests.some(r => r.id === answering.id)) setAnswering(null);
  }, [list, answering]);

  return (
    <div className="preview-links">
      <p className="preview-links-lede">
        A link to the app on this box, at its own address, that opens in their own browser. Only the app is reachable: no
        terminals, agent or files.
      </p>
      {error && <p className="preview-links-error" role="alert">{error}</p>}
      <PublishPreviewLink
        projectId={projectId}
        projectName={projectName}
        workstream={workstream}
        links={list?.links ?? null}
        ttlHoursDefault={list?.ttlHoursDefault ?? 24}
        audiencesOn={audiencesOn}
        onBusyChange={onBusyChange}
        answering={answering}
        onCancelAnswer={() => setAnswering(null)}
        onPublished={() => { setAnswering(null); reload(); }}
      />
      {list && (
        <PreviewLinksList links={list.links} requests={list.requests} ttlHoursDefault={list.ttlHoursDefault} onChanged={reload} onAnswer={setAnswering}
          workstream={workstream} workstreamName={workstreamName} unremovable={unremovable} />
      )}
    </div>
  );
}
