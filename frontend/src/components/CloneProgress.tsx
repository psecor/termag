import React from 'react';
import type { Project } from '../types';
import { cloneTile } from '../utils/cloneTile';
import { useSetupContext } from '../hooks/useSetupContext';

export function CloneProgress({
  project,
  busy,
  onRetry,
  onStartEmpty,
}: {
  project: Pick<Project, 'setupStatus' | 'setupError' | 'role' | 'instanceId' | 'repoUrl'>;
  busy: boolean;
  onRetry: () => void;
  onStartEmpty: () => void;
}) {
  const ctx = useSetupContext(project);
  const view = cloneTile(project.setupStatus, ctx);
  if (!view.label) return null;
  const owner = project.role !== 'collaborator';
  return (
    <span className="clone-progress" onClick={e => e.stopPropagation()}>
      <span
        className={`clone-badge is-${view.phase}`}
        title={view.phase === 'failed' ? (ctx.boxFailed ? ctx.boxError : project.setupError) ?? undefined : undefined}
      >
        {view.label}
      </span>
      {owner && view.retry && (
        <button type="button" className="btn-tiny" disabled={busy} onClick={onRetry}>Retry</button>
      )}
      {owner && view.startEmpty && (
        <button type="button" className="btn-tiny" disabled={busy} onClick={onStartEmpty}>Start empty</button>
      )}
    </span>
  );
}
