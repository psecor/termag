// A follow-up round's card: after the
// author pushes or asks again, Check the fixes has the review session read
// the new head and answer with a ```review follow-up fence: each of the
// user's posted comments and what the head does about it, and anything new.
// The gates in front of an approval are termag's own read of GitHub
// (chat/approvalGates.ts), not the reviewer's: the user's threads resolved,
// checks, Bugbot and the Security agent clean on this head, and auto-merge,
// said out loud. Approve waits for them, confirms, and when auto-merge is on
// says it merges; "Turn off auto-merge, then approve" is the other way.
import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, ButtonGroup, Dialog, Heading, Modal, ModalOverlay, ProgressBar, Text } from '@launchpad-ui/components';
import { Icon, type IconName } from '@launchpad-ui/icons';
import { LP_THEME } from '../../launchpad/theme';
import { prsApi, type PrOverview, type PrThread } from '../../services/api';
import { apiErrorText, PRS_CHANGED_EVENT } from '../../utils/prPipeline';
import { approvalGates, type ApprovalGate } from '../../chat/approvalGates';
import type { ReviewFollowUp } from '../../chat/reviewCard';
import { cardKey, updateCard, useCardState } from '../../chat/reviewDrafts';
import { prShort } from '../../chat/reviews';
import { CardHead, FollowUpList } from './ReviewCard';

const GATE_ICON: Record<ApprovalGate['key'], IconName> = {
  threads: 'chat-bubble-outline', checks: 'check-circle-outline', bugbot: 'bug', security: 'shield-account-outline', head: 'arrow-merge', automerge: 'arrow-merge',
};

export function FollowUpCard({ fence, projectId, workstream, repo, number, viewer, approvedOnServer = false }: {
  fence: ReviewFollowUp; projectId: string; workstream: string; repo: string; number: number; viewer: string | null;
  /** The server has this round's approval (pr_review_rounds). */
  approvedOnServer?: boolean;
}) {
  const key = cardKey(projectId, workstream, fence.round);
  const state = useCardState(key);
  const [pr, setPr] = useState<PrOverview | null>(null);
  const [threads, setThreads] = useState<PrThread[] | null | 'unreadable'>(null);
  const [confirming, setConfirming] = useState<null | 'approve' | 'off-then-approve'>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The PR can't be read: said so, and Approve held, rather than a spinner that never ends.
  const [unread, setUnread] = useState(false);
  // Only the newest read's answer counts, so a slow one can't undo a later one. A failed read holds Approve until a
  // read works, Read again's included.
  const reads = useRef(0);
  const read = () => {
    const n = ++reads.current;
    prsApi.overview(repo, number).then(o => { if (n === reads.current) { setPr(o); setUnread(false); } }, () => { if (n === reads.current) setUnread(true); });
    prsApi.threads(repo, number).then(t => { if (n === reads.current) setThreads(t); }, () => { if (n === reads.current) setThreads('unreadable'); });
  };
  useEffect(read, [repo, number]);
  const approved = approvedOnServer || state.posted?.event === 'APPROVE';
  const { gates, ready: gatesReady } = pr ? approvalGates(pr, threads, viewer ?? pr.viewer ?? null, fence.head) : { gates: [], ready: false };
  // A read that failed after one that worked leaves the gates as they were: nothing to approve on until one works.
  const ready = gatesReady && !unread;
  const allFixed = fence.addressed.every(a => a.fixed) && fence.fresh.length === 0;

  const approve = async (turnOffFirst: boolean) => {
    if (!pr) return;
    setBusy(true); setError(null);
    try {
      // GitHub may have moved since the gates were read: read it again, and approve only what still passes,
      // pinned to that head, under the auto-merge the confirm named.
      const [now, nowThreads] = await Promise.all([prsApi.overview(repo, number), prsApi.threads(repo, number).catch(() => 'unreadable' as const)]);
      // The newest read now: one still in flight from before can't replace it.
      reads.current++; setPr(now); setThreads(nowThreads); setUnread(false);
      if (!approvalGates(now, nowThreads, viewer ?? now.viewer ?? null, fence.head).ready) {
        setError('Something changed on GitHub since the gates were read. Check them again.');
        return;
      }
      if (now.autoMerge !== pr.autoMerge) {
        setError(now.autoMerge ? 'Auto-merge was turned on since: approving now would merge it. Check again.' : 'Auto-merge was turned off since. Check again.');
        return;
      }
      // Only while it's on: a retry after an approval that failed finds it off already, and GitHub refuses to turn
      // off what is off.
      if (turnOffFirst && now.autoMerge) {
        await prsApi.merge(repo, number, { mode: 'cancel_auto' });
        // Off now, whatever the approval does next: a retry compares against this, not the read before.
        setPr({ ...now, autoMerge: false });
      }
      const res = await prsApi.review(repo, number, 'APPROVE', '', { commitId: now.headSha ?? undefined, title: now.title, author: now.author });
      updateCard(key, { posted: { event: 'APPROVE', comments: 0, at: new Date().toISOString(), url: res.url } });
      window.dispatchEvent(new Event(PRS_CHANGED_EVENT));
      read();
      setConfirming(null);
    } catch (err) {
      setError(apiErrorText(err, 'GitHub refused the approval'));
      read();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rv-card">
      <CardHead label={prShort(repo, number)} round={fence.round} head={fence.head} />
      {approved
        ? <Alert status="success" className="rv-alert"><Text elementType="p"><strong>Approved</strong> at <code>{pr?.headSha?.slice(0, 7) ?? fence.head.slice(0, 7)}</code>{pr?.state === 'MERGED' ? <>, and it merged into <strong>{pr.baseRefName}</strong></> : pr?.autoMerge && !confirming ? '; auto-merge takes it from here' : ''}.</Text></Alert>
        : <Alert status={allFixed ? 'success' : 'warning'} className="rv-alert"><Text elementType="p">{allFixed ? <><strong>Every comment is addressed.</strong> {ready ? 'Every gate is clear.' : 'Approve once the gates below are clear.'}</> : <><strong>Not all of it is fixed.</strong> See below.</>}</Text></Alert>}
      <h4 className="rv-sub">Your comments</h4>
      <FollowUpList fence={fence} />
      {!approved && <>
      <h4 className="rv-sub">Before you approve <Button variant="minimal" size="small" onPress={read} className="rv-reread">Read again</Button></h4>
      {!pr && !unread && <div className="rv-loading-line rv-pad"><ProgressBar variant="spinner" size="small" isIndeterminate aria-label="Reading GitHub" /> Reading GitHub…</div>}
      {unread && <p className="rv-note rv-pad" role="alert">{pr ? "Couldn't read the PR from GitHub again: the gates below are from the last read, so Approve waits." : "Couldn't read the PR from GitHub, so Approve waits."} Read again to retry.</p>}
      <ul className="rv-gates" aria-label="Before you approve">
        {gates.map(g => (
          <li key={g.key} data-tone={g.tone}>
            {g.tone === 'running'
              ? <span className="rv-gate-mark"><ProgressBar variant="spinner" size="small" isIndeterminate aria-label="Running" /></span>
              : <Icon name={g.tone === 'pass' ? 'check-circle' : g.tone === 'warn' ? 'warning' : 'cancel-circle'} size="medium" aria-hidden="true" className="rv-gate-mark" />}
            <Icon name={GATE_ICON[g.key]} size="medium" aria-hidden="true" className="rv-gate-icon" />
            <span className="rv-gate-name">{g.name}</span>
            <span className="rv-gate-detail">{g.detail}</span>
          </li>
        ))}
      </ul>
      </>}
      {!approved && pr && (
        <div className="rv-foot">
          <ButtonGroup className="rv-actions">
            <Button variant="primary" isDisabled={!ready || busy} onPress={() => setConfirming('approve')}>{pr.autoMerge ? 'Approve and merge…' : 'Approve…'}</Button>
            {pr.autoMerge && <Button variant="default" isDisabled={!ready || busy} onPress={() => setConfirming('off-then-approve')}>Turn off auto-merge, then approve</Button>}
          </ButtonGroup>
          {!ready && <span className="rv-as">Approve waits for every gate</span>}
        </div>
      )}
      {confirming && pr && (
        <ModalOverlay isOpen isDismissable={!busy} onOpenChange={open => { if (!open) setConfirming(null); }} className={LP_THEME}>
          <Modal size="small" className="rv-confirm">
            <Dialog role="alertdialog" className="rv-confirm-dialog">
              <Heading slot="title" level={2} size="medium">
                {confirming === 'approve' && pr.autoMerge ? `Approve and merge ${prShort(repo, number)}?` : `Approve ${prShort(repo, number)}?`}
              </Heading>
              <Text elementType="p" slot="subtitle">
                {confirming === 'approve' && pr.autoMerge
                  ? <>Auto-merge is on, so your approval merges it into <strong>{pr.baseRefName}</strong> right away, as {viewer ?? 'you'}.</>
                  : confirming === 'off-then-approve'
                    ? <>Auto-merge goes off first, then you approve as {viewer ?? 'you'}. Nothing merges until someone merges it.</>
                    : <>You approve as {viewer ?? 'you'}, at <code>{pr.headSha?.slice(0, 7)}</code>.</>}
              </Text>
              {error && <p className="rv-confirm-error" role="alert">{error}</p>}
              <ButtonGroup className="rv-confirm-buttons">
                <Button variant="minimal" onPress={() => setConfirming(null)} isDisabled={busy}>Cancel</Button>
                <Button variant="primary" autoFocus isDisabled={busy} onPress={() => { void approve(confirming === 'off-then-approve'); }}>
                  {busy ? 'Approving…' : confirming === 'approve' && pr.autoMerge ? 'Approve and merge' : 'Approve'}
                </Button>
              </ButtonGroup>
            </Dialog>
          </Modal>
        </ModalOverlay>
      )}
    </div>
  );
}
