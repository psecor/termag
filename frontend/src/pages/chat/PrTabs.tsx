// A PR in GitHub's own tabs: Conversation
// (PrConversation: the description, the files, the review form or merge
// panel, with reviewers, checks and merge state beside them), Files changed (PrFilesView: the diff with every review thread on its
// line, and a review's drafts), and Checks (the gates in front of the merge,
// then each check). On a PR's page, and beside a review session.
import React, { useEffect, useState } from 'react';
import { Tab, TabList, TabPanel, Tabs } from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { prsApi, type PrOverview, type PrPipelineResponse, type PrRow } from '../../services/api';
import { apiErrorText } from '../../utils/prPipeline';
import { PrConversation } from './PrConversation';
import { GateList } from './PrTab';
import { PrFilesView, type DraftComment } from './PrFilesView';

export type PrTabKey = 'conversation' | 'files' | 'checks';

const CHECK_ICON = { passed: 'check-circle', failed: 'cancel-circle', pending: 'clock' } as const;

export function PrTabs({ row, prs, onChanged, drafts, focus, tab, onTab }: {
  row: PrRow & { repo: string; number: number };
  prs: PrPipelineResponse | null;
  onChanged: () => void;
  drafts?: DraftComment[];
  /** The line to show; `at` changes when it's asked for again. */
  focus?: { path: string; line: number; at?: number } | null;
  /** The tab shown, where the caller steers it (a finding clicked opens Files changed). */
  tab?: PrTabKey;
  onTab?: (tab: PrTabKey) => void;
}) {
  const [own, setOwn] = useState<PrTabKey>('conversation');
  const shown = tab ?? own;
  // The overview read for this PR only: on the first paint after a switch, the last PR's checks and file count
  // aren't shown while this one's is read (a pipeline re-read keeps the overview until it answers).
  const pr = `${row.repo}#${row.number}`;
  // A re-read that fails keeps the PR shown (the next one may answer); the error shows only while there's none.
  const [read, setRead] = useState<{ pr: string; overview: PrOverview } | null>(null);
  const [failed, setFailed] = useState<{ pr: string; error: string } | null>(null);
  const overview = read && read.pr === pr ? read.overview : null;
  useEffect(() => {
    let live = true;
    const key = `${row.repo}#${row.number}`;
    prsApi.overview(row.repo, row.number).then(
      o => { if (live) { setRead({ pr: key, overview: o }); setFailed(null); } },
      err => { if (live) setFailed({ pr: key, error: apiErrorText(err, 'Could not read the pull request from GitHub.') }); },
    );
    return () => { live = false; };
  }, [row.repo, row.number, prs]);
  const show = (t: PrTabKey) => { setOwn(t); onTab?.(t); };
  const fileCount = overview?.changedFiles ?? null;
  const checks = overview?.checks ?? [];
  return (
    <Tabs selectedKey={shown} onSelectionChange={k => show(k as PrTabKey)} className="rv-tabs">
      <TabList aria-label="Pull request" className="rv-tablist">
        <Tab id="conversation">Conversation</Tab>
        <Tab id="files">Files changed{fileCount != null && <span className="rv-tab-count">{fileCount}</span>}</Tab>
        <Tab id="checks">Checks{checks.length > 0 && <span className="rv-tab-count">{checks.length}</span>}</Tab>
      </TabList>
      <TabPanel id="conversation" className="rv-tabpanel">
        <PrConversation key={pr} row={row} pr={overview} error={failed && failed.pr === pr ? failed.error : null} now={Date.now()}
          onChanged={onChanged} onShowFiles={() => show('files')} />
      </TabPanel>
      <TabPanel id="files" className="rv-tabpanel">
        {/* Keyed by the PR, as PrConversation is: another PR's diff and threads start empty, not on the last one's. */}
        <PrFilesView key={pr} repo={row.repo} number={row.number} drafts={drafts} focus={focus} />
      </TabPanel>
      <TabPanel id="checks" className="rv-tabpanel">
        {overview && overview.state === 'OPEN' && (
          <section className="pr-panel-gates rv-gates-box">
            <h4 className="ctx-heading">Before it merges</h4>
            <GateList pr={overview} />
          </section>
        )}
        <ul className="rv-checks" aria-label="Checks">
          {checks.map(c => (
            <li key={c.name} data-state={c.state}>
              <Icon name={CHECK_ICON[c.state]} size="small" aria-hidden="true" />
              <span>{c.name}</span>
              <span className="rv-checks-state">{c.state}</span>
            </li>
          ))}
          {overview && checks.length === 0 && <li className="rv-note">No checks on this head.</li>}
        </ul>
      </TabPanel>
    </Tabs>
  );
}
