// The chrome refresh's context card: the
// session at a glance in the conversation's right gutter, while the side panel
// is shut and the conversation is wide enough (chrome.css, a container query).
// Where it runs (the box and its state, the space, the repository and branch),
// what its pull request changes (files with +/−), and that PR with the gates in
// front of its merge; the PR opens the panel's Pull request tab. All real data:
// the project, the box feed, and the full UI's PR pipeline (useSessionPr.ts).
// With simple-ui-inflight-changes-enabled, Changes also lists what the agent has
// changed and not committed or not pushed yet, from the box (useSessionChanges.ts).
import React, { useSyncExternalStore } from 'react';
import { Button } from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import type { ChangedFile, PrFile } from '../../services/api';
import type { InstanceStatus, Project } from '../../types';
import { boxFeed } from '../../services/boxFeed';
import { boxLabel, repoSlug } from '../../chat/simpleChat';
import { prGates } from '../../chat/prGates';
import { ChatSpaceChip } from './SpaceSwatch';
import { GateList } from './PrTab';
import { useSessionPr } from './useSessionPr';
import { useSessionChanges } from './useSessionChanges';
import { fileKind, inflightGroups, noPrChangesText } from '../../chat/inflightChanges';
import { FLAGS, useFlag } from '../../flags';

const CHANGE_KIND: Record<string, string> = { ADDED: 'A', DELETED: 'D', RENAMED: 'R', COPIED: 'C', CHANGED: 'M', MODIFIED: 'M' };
const BOX_STATE: Record<InstanceStatus, { text: string; status: 'pass' | 'waiting' | 'off' | 'fail' }> = {
  ready: { text: 'Running', status: 'pass' },
  starting: { text: 'Starting', status: 'waiting' },
  'awaiting-agent': { text: 'Starting', status: 'waiting' },
  provisioning: { text: 'Starting', status: 'waiting' },
  warming: { text: 'Starting', status: 'waiting' },
  warm: { text: 'Starting', status: 'waiting' },
  stopping: { text: 'Stopping', status: 'waiting' },
  stopped: { text: 'Stopped', status: 'off' },
  hibernating: { text: 'Hibernating', status: 'waiting' },
  hibernated: { text: 'Hibernated', status: 'off' },
  failed: { text: 'Failed', status: 'fail' },
  terminated: { text: 'Terminated', status: 'off' },
  quarantined: { text: 'Quarantined', status: 'fail' },
};
const FILES_SHOWN = 8;

/** +adds −dels, and a five-cell bar in their proportion, as GitHub draws it. */
export function Numstat({ add, del, bar = false }: { add: number; del: number; bar?: boolean }) {
  const total = add + del;
  const green = total ? Math.round((add / total) * 5) : 0;
  return (
    <span className="ctx-numstat" aria-label={`${add} added, ${del} removed`}>
      <span className="ctx-add" aria-hidden="true">+{add}</span>
      <span className="ctx-del" aria-hidden="true">−{del}</span>
      {bar && (
        <span className="ctx-bar" aria-hidden="true">
          {Array.from({ length: 5 }, (_, i) => <span key={i} data-kind={i < green ? 'add' : total ? 'del' : 'none'} />)}
        </span>
      )}
    </span>
  );
}

interface FileRow { path: string; kind: string; additions: number | null; deletions: number | null; title?: string }

const prRow = (f: PrFile): FileRow => ({ path: f.path, kind: CHANGE_KIND[f.changeType] ?? 'M', additions: f.additions, deletions: f.deletions });
const changedRow = (f: ChangedFile): FileRow => ({
  path: f.path, kind: fileKind(f.status), additions: f.additions, deletions: f.deletions,
  title: f.status === '?' ? `${f.path} (not tracked yet)` : f.from ? `${f.from} → ${f.path}` : f.path,
});

/** `moreAtLeast`: the box cut the list, so "more" is a floor. */
function FileList({ files, more, moreAtLeast = false }: { files: FileRow[]; more: number; moreAtLeast?: boolean }) {
  return (
    <ul className="ctx-files">
      {files.map(f => {
        const slash = f.path.lastIndexOf('/');
        return (
          <li key={f.path} title={f.title ?? f.path}>
            <span className="ctx-file-kind" data-kind={f.kind} aria-hidden="true">{f.kind}</span>
            <code className="ctx-file-path"><span className="ctx-file-dir">{slash >= 0 ? f.path.slice(0, slash + 1) : ''}</span>{f.path.slice(slash + 1)}</code>
            {f.additions !== null && f.deletions !== null && <Numstat add={f.additions} del={f.deletions} />}
          </li>
        );
      })}
      {more > 0 && <li className="ctx-files-more">and {more}{moreAtLeast ? '+' : ''} more</li>}
    </ul>
  );
}

/** `agents`: the chat's subagents kept in view, first (Subagents.tsx AgentsCardSection, behind chat-subagents-enabled). */
export function SessionContextCard({ project, workstream, onOpenPr, agents }: { project: Project; workstream: string; onOpenPr?: () => void; agents?: React.ReactNode }) {
  const boxes = useSyncExternalStore(boxFeed.subscribe, boxFeed.getSnapshot);
  const box = project.instanceId ? boxes.find(b => b.id === project.instanceId) ?? null : null;
  const boxName = boxLabel(
    { instanceId: project.instanceId ?? null, shared: project.role === 'collaborator', owner: project.ownerUsername ?? '' },
    box?.name,
  );
  const boxState = box ? BOX_STATE[box.status] as (typeof BOX_STATE)[InstanceStatus] | undefined : undefined;
  const repo = repoSlug(project.repoUrl);
  const wsRow = project.workstreams?.find(w => w.name === workstream);
  const branch = wsRow?.branch ?? null;
  const { row, overview, loading, overviewFailed } = useSessionPr(project.id, workstream);
  // Read from the worktree on the PR's branch when there is a PR, else the workstream's checkout.
  const inflightOn = useFlag(FLAGS.inflightChanges, false);
  const changes = useSessionChanges(project.id, workstream, loading ? undefined : row?.headRefName ?? null);
  const groups = inflightGroups(changes);
  const prFiles = overview && overview.files.length > 0 ? overview.files : [];
  const open = overview?.state === 'OPEN';
  const gates = overview && open ? prGates(overview) : [];
  const clear = gates.filter(g => g.status === 'pass').length;

  return (
    <aside className="ctx-card" aria-label="Session context">
      {agents}
      <section className="ctx-section">
        <h4 className="ctx-heading">Where</h4>
        <div className="ctx-rows">
          {boxName && (
            <div className="ctx-row">
              <Icon name="device-server" size="medium" aria-hidden="true" />
              <span>{boxName}</span>
              {boxState && <span className="ctx-pill" data-status={boxState.status}>{boxState.text}</span>}
            </div>
          )}
          <div className="ctx-row ctx-row-space"><ChatSpaceChip place={{ instanceId: project.instanceId ?? null, spaceId: wsRow?.spaceId, spaceFixed: wsRow?.spaceFixedAt != null }} /></div>
          {repo && <div className="ctx-row"><Icon name="code" size="medium" aria-hidden="true" /><span>{repo}</span></div>}
          {branch && <div className="ctx-row"><Icon name="arrow-merge" size="medium" aria-hidden="true" /><code>{branch}</code></div>}
        </div>
      </section>
      <section className="ctx-section">
        <h4 className="ctx-heading">
          Changes
          {overview && overview.changedFiles > 0 && (
            <span className="ctx-heading-aside">{overview.changedFiles} {overview.changedFiles === 1 ? 'file' : 'files'} <Numstat add={overview.additions} del={overview.deletions} bar /></span>
          )}
        </h4>
        {changes?.available && changes.worktree && groups.length > 0 && (
          <p className="ctx-where">In <code>{changes.worktree}</code></p>
        )}
        {groups.map(g => (
          <div key={g.key} className="ctx-group" data-group={g.key}>
            <h5 className="ctx-subheading">
              {g.label}
              {g.unlisted > 0
                ? <span className="ctx-heading-aside">{g.unlisted} {g.unlisted === 1 ? 'commit' : 'commits'}</span>
                : <span className="ctx-heading-aside">{g.files.length}{g.cut ? '+' : ''} {g.files.length === 1 ? 'file' : 'files'} <Numstat add={g.additions} del={g.deletions} /></span>}
            </h5>
            {g.unlisted > 0
              ? <p className="ctx-empty">Couldn’t list their files</p>
              : <FileList files={g.files.slice(0, FILES_SHOWN).map(changedRow)} more={Math.max(0, g.files.length - FILES_SHOWN)} moreAtLeast={g.cut} />}
          </div>
        ))}
        {groups.length > 0 && prFiles.length > 0 && <h5 className="ctx-subheading">In the pull request</h5>}
        {prFiles.length > 0
          ? <FileList files={prFiles.slice(0, FILES_SHOWN).map(prRow)} more={Math.max(0, overview!.changedFiles - Math.min(FILES_SHOWN, prFiles.length))} />
          : groups.length === 0 && (
            <p className="ctx-empty">
              {!row ? noPrChangesText(inflightOn, changes)
                : overview ? 'No changes' : overviewFailed ? 'Couldn’t read them from GitHub' : 'Reading from GitHub…'}
            </p>
          )}
      </section>
      <section className="ctx-section">
        <h4 className="ctx-heading">Pull request</h4>
        {row ? (
          <>
            <Button variant="minimal" className="ctx-pr" onPress={onOpenPr} isDisabled={!onOpenPr}>
              <span className="ctx-pr-state" data-state={overview?.state?.toLowerCase() ?? (row.mergedAt ? 'merged' : 'open')} aria-hidden="true">
                <Icon name="arrow-merge" size="medium" />
              </span>
              <span className="ctx-pr-text">
                <span className="ctx-pr-title">{overview?.title ?? row.title}</span>
                <span className="ctx-pr-sub">
                  #{row.number}
                  {overview && !open && ` · ${overview.state === 'MERGED' ? 'merged' : 'closed'}`}
                  {open && ` · ${clear} of ${gates.length} gates clear`}
                </span>
              </span>
              <Icon name="chevron-right" size="medium" className="ctx-pr-go" aria-hidden="true" />
            </Button>
            {overview && open && <GateList pr={overview} />}
          </>
        ) : <p className="ctx-empty">{loading ? 'Looking for it…' : 'No pull request yet'}</p>}
      </section>
    </aside>
  );
}
