import React from 'react';
import type { Project } from '../types';
import { environmentView } from '../utils/environmentStatus';
import { browserPortHref } from '../utils/browserPaneConnection';

/**
 * The environment file's steps on the session's box,
 * in the simple UI's context card (pages/chat/SessionContextCard.tsx): their
 * state with setup's time, then a row per port, its dot green once healthy.
 * A port is a link: it opens that port, at its path, in a new tab, in the
 * owner's own browser pane on the box (browserPortHref), in whichever UI they
 * use. Nothing without a report.
 */
export function EnvironmentSection({ project, workstream }: { project: Pick<Project, 'id' | 'environmentStatus'>; workstream: string }) {
  const view = environmentView(project.environmentStatus);
  if (!view) return null;
  const pill = view.phase === 'up' ? 'ready' : view.phase === 'failed' ? 'fail' : view.phase === 'idle' ? 'off' : 'waiting';
  return (
    <section className="ctx-section ctx-env" title={view.title}>
      <h4 className="ctx-heading">Environment</h4>
      <div className="ctx-rows">
        <div className="ctx-row"><span className="ctx-pill ctx-env-state" data-status={pill}>{view.label}</span></div>
        {view.ports.map(p => (
          <a
            key={p.port}
            className={`ctx-row ctx-env-port${p.healthy ? ' is-healthy' : ''}`}
            href={browserPortHref(project.id, workstream, p.url)}
            target="_blank"
            rel="noopener"
            title={`Open ${p.url} in a new tab (${p.healthy ? 'healthy' : 'not healthy yet'})`}
          >
            <span className="env-port-dot" aria-hidden="true" />
            <span>{p.name}</span>
            <span className="ctx-env-port-number">:{p.port}</span>
          </a>
        ))}
      </div>
    </section>
  );
}
