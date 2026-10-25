import { describe, expect, it } from 'vitest';
import {
  archiveBoxNotice, archiveSettling, archivedBoxLabel, archivedChatOpen, canReopen, deleteLeavesOpenChat, dismissRunningBox,
  droppingRecoveryShowsMissing, dropLastActiveProject, forgetRunningBox, historyComingUp, historyFailureIsSetup,
  isPowerRestart, offerRunningBox, parkedPowerError, permanentDeleteDetail, recoveryForOpen, rememberRunningBox, reopenCatchUp, reopenOpensChat,
  chatsAfterPermanentDelete,
  runningBoxFromNotice, runningBoxRecovery, runningBoxStillUp, settleRunningBoxes, stillRunningWorkspaceHref,
  type RunningBoxRecovery,
} from './archive';

describe('archivedBoxLabel', () => {
  it('says where the box is in a few words', () => {
    expect(archivedBoxLabel('stopped')).toBe('box stopped');
    expect(archivedBoxLabel('hibernated')).toBe('box hibernated');
    expect(archivedBoxLabel('stopping')).toBe('box stopping…');
    expect(archivedBoxLabel('terminated')).toBe('box gone');
    expect(archivedBoxLabel('awaiting-agent')).toBe('box awaiting agent');
    expect(archivedBoxLabel(null)).toBe('no box');
  });
});

describe('canReopen', () => {
  it('reopens a parked or running box, not one still going down or gone', () => {
    expect(canReopen('stopped')).toBe(true);
    expect(canReopen('hibernated')).toBe(true);
    expect(canReopen('ready')).toBe(true);
    expect(canReopen('stopping')).toBe(false);
    expect(canReopen('hibernating')).toBe(false);
    expect(canReopen('terminated')).toBe(false);
    expect(canReopen(null)).toBe(false);
  });
});

describe('archiveSettling', () => {
  it('is true while any box is on its way down or up', () => {
    expect(archiveSettling(['stopped', 'stopping'])).toBe(true);
    expect(archiveSettling(['stopped', 'hibernated', null])).toBe(false);
  });
});

describe('isPowerRestart', () => {
  it('is a box coming back from a stop or hibernate, not one on its first boot', () => {
    expect(isPowerRestart('starting')).toBe(true);
    expect(isPowerRestart('hibernated')).toBe(true);
    expect(isPowerRestart('provisioning')).toBe(false);
    expect(isPowerRestart('ready')).toBe(false);
    expect(isPowerRestart(null)).toBe(false);
  });
});

describe('reopenOpensChat', () => {
  it('opens only once the parked turn was cleared', () => {
    expect(reopenOpensChat({ reopened: true })).toBe(true);
    expect(reopenOpensChat({ reopened: false })).toBe(false);
    expect(reopenOpensChat(null)).toBe(false);
  });
});

describe('reopenCatchUp', () => {
  it('treats a start, and a feed that still says parked, as the box coming up', () => {
    expect(reopenCatchUp({ status: 'starting', name: 'box-a' })).toEqual({ reopenStarting: true, reopenBoxName: 'box-a' });
    expect(reopenCatchUp({ status: 'stopped', name: 'box-a' })?.reopenStarting).toBe(true);
    expect(reopenCatchUp({ status: 'hibernated' })?.reopenBoxName).toBe('box');
  });

  it('leaves a box that was already ready out of the setup narration', () => {
    expect(reopenCatchUp({ status: 'ready', name: 'box-a' })).toBeNull();
    expect(reopenCatchUp(null)).toBeNull();
  });
});

describe('historyComingUp', () => {
  it('is true while the feed says starting, with or without a reopen', () => {
    expect(historyComingUp('starting', false)).toBe(true);
    expect(historyComingUp('starting', true)).toBe(true);
  });

  it('keeps a reopen in setup while the feed is still parked or not loaded', () => {
    expect(historyComingUp('stopped', true)).toBe(true);
    expect(historyComingUp('hibernated', true)).toBe(true);
    expect(historyComingUp(null, true)).toBe(true);
    expect(historyComingUp(undefined, true)).toBe(true);
  });

  it('is an offline error for an established chat, and once a reopen\'s box is ready', () => {
    expect(historyComingUp('ready', false)).toBe(false);
    expect(historyComingUp('stopped', false)).toBe(false);
    expect(historyComingUp('hibernated', false)).toBe(false);
    expect(historyComingUp(null, false)).toBe(false);
    expect(historyComingUp('ready', true)).toBe(false);
  });
});

describe('historyFailureIsSetup', () => {
  it('keeps narrating setup while the project is still being set up', () => {
    expect(historyFailureIsSetup('setup', false)).toBe(true);
    expect(historyFailureIsSetup('setup', true)).toBe(true);
  });

  it('treats offline as setup only while the box is coming up', () => {
    expect(historyFailureIsSetup('offline', historyComingUp('starting', false))).toBe(true);
    expect(historyFailureIsSetup('offline', historyComingUp('stopped', true))).toBe(true);
    expect(historyFailureIsSetup('offline', historyComingUp('ready', false))).toBe(false);
    expect(historyFailureIsSetup('offline', historyComingUp('stopped', false))).toBe(false);
  });

  it('shows any other failure, including an established chat whose agent dropped', () => {
    expect(historyFailureIsSetup(null, false)).toBe(false);
    expect(historyFailureIsSetup(null, true)).toBe(false);
    expect(historyFailureIsSetup('runner-missing', false)).toBe(false);
    expect(historyFailureIsSetup('no-box', true)).toBe(false);
  });
});

describe('runningBoxRecovery', () => {
  const recovery: RunningBoxRecovery = {
    projectId: 'p', projectName: 'termag', instanceId: 'box-1', message: 'Its box is still running', retry: 'stop', announced: true,
  };

  it('keeps the Stop recovery after the chat has left the live list', () => {
    const remembered = rememberRunningBox({}, recovery);
    expect(runningBoxRecovery(remembered, 'p')).toEqual(recovery);
    expect(runningBoxRecovery(remembered, 'other')).toBeNull();
    expect(runningBoxRecovery(forgetRunningBox(remembered, 'p'), 'p')).toBeNull();
  });

  it('leaves the store alone when the chat had no recovery', () => {
    const store = rememberRunningBox({}, recovery);
    expect(forgetRunningBox(store, 'missing')).toBe(store);
  });

  it('drops the chat from the live open and still shows Stop or Hibernate', () => {
    const stopped = archiveBoxNotice({ action: 'stop', error: 'EC2 refused the stop' });
    if (stopped.leave) throw new Error('a power failure stays on the chat');
    const recovery = runningBoxFromNotice({ id: 'p', name: 'termag', instanceId: 'box-1' }, stopped);
    expect(recovery).toMatchObject({ retry: 'stop', announced: true, instanceId: 'box-1' });
    const store = rememberRunningBox({}, recovery);
    // Gone from the live list: this open is the recovery panel, not the pane chat's 404.
    expect(archivedChatOpen(false, runningBoxRecovery(store, 'p'))).toBe('recovery');
    // Still listed for a moment: the live view reads the same recovery instead of starting clean.
    expect(archivedChatOpen(true, runningBoxRecovery(store, 'p'))).toBe('live');
    expect(runningBoxRecovery(store, 'p')?.message).toMatch(/still running/);
    const dismissed = dismissRunningBox(store, 'p');
    expect(runningBoxRecovery(dismissed, 'p')).toMatchObject({ retry: 'stop', announced: false });
    expect(archivedChatOpen(false, runningBoxRecovery(dismissed, 'p'))).toBe('recovery');
    expect(dismissRunningBox(dismissed, 'p')).toBe(dismissed);

    const hibernated = archiveBoxNotice({ action: 'hibernate', error: 'Hibernation is unavailable' });
    if (hibernated.leave) throw new Error('a power failure stays on the chat');
    const hibernate = runningBoxFromNotice({ id: 'h', name: 'other', instanceId: null }, hibernated);
    expect(archivedChatOpen(false, hibernate)).toBe('recovery');
    expect(hibernate.retry).toBe('hibernate');
    expect(archivedChatOpen(false, null)).toBe('missing');
  });

  it('offers Stop only while the archived row says the box is still up', () => {
    expect(runningBoxStillUp('ready')).toBe(true);
    expect(runningBoxStillUp('starting')).toBe(true);
    expect(runningBoxStillUp('provisioning')).toBe(true);
    for (const status of ['stopping', 'stopped', 'hibernating', 'hibernated', 'terminated', 'failed', null, undefined]) {
      expect(runningBoxStillUp(status)).toBe(false);
      expect(offerRunningBox(true, status)).toBe(false);
    }
    expect(offerRunningBox(false, 'ready')).toBe(false);
    expect(offerRunningBox(true, 'ready')).toBe(true);

    const store = rememberRunningBox({}, recovery);
    const settled = settleRunningBoxes(store, [
      { id: 'p', status: 'stopped' },
      { id: 'other', status: 'ready' },
    ]);
    expect(runningBoxRecovery(settled, 'p')).toBeNull();
    expect(settleRunningBoxes(store, [{ id: 'p', status: 'ready' }])).toBe(store);
    expect(settleRunningBoxes(store, [{ id: 'missing', status: 'stopped' }])).toBe(store);

    expect(recoveryForOpen(recovery, 'stopped', true)).toBeNull();
    expect(recoveryForOpen(recovery, null, true)).toBeNull();
    expect(recoveryForOpen(recovery, 'ready', true)).toBe(recovery);
    expect(recoveryForOpen(recovery, 'stopped', false)).toBe(recovery);
    expect(recoveryForOpen({ ...recovery, instanceId: null }, null, true)).toEqual({ ...recovery, instanceId: null });
    expect(parkedPowerError("Can't stop a box that is stopped")).toBe(true);
    expect(parkedPowerError("Can't hibernate a box that is hibernated")).toBe(true);
    expect(parkedPowerError('EC2 refused the stop')).toBe(false);
  });

  it('does not drop the recovery while the chat URL would show the conversation as missing', () => {
    expect(droppingRecoveryShowsMissing(false, false)).toBe(true);
    expect(archivedChatOpen(false, null)).toBe('missing');
    // Reopen: the project is back on the live list, so clearing is the chat.
    expect(droppingRecoveryShowsMissing(true, false)).toBe(false);
    expect(archivedChatOpen(true, null)).toBe('live');
    // Delete: the URL has left the chat, so clearing is not this page.
    expect(droppingRecoveryShowsMissing(false, true)).toBe(false);
  });
});

describe('stillRunningWorkspaceHref', () => {
  it('opens the workspace home, not the archived project', () => {
    expect(stillRunningWorkspaceHref()).toBe('/');
    expect(stillRunningWorkspaceHref()).not.toContain('project=');
  });

  it('forgets the last-active id when it is this archived chat', () => {
    const store = new Map<string, string>([['termag:lastActiveProject', 'chat-1']]);
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      removeItem: (k: string) => { store.delete(k); },
    };
    dropLastActiveProject('chat-1', storage);
    expect(store.has('termag:lastActiveProject')).toBe(false);
    store.set('termag:lastActiveProject', 'other');
    dropLastActiveProject('chat-1', storage);
    expect(store.get('termag:lastActiveProject')).toBe('other');
    dropLastActiveProject('chat-1', null);
  });
});

describe('permanentDeleteDetail', () => {
  const box = { status: 'stopped' };

  it('says the box is terminated only when this chat is the last project on it', () => {
    expect(permanentDeleteDetail(box, 0)).toMatch(/box is terminated/);
    expect(permanentDeleteDetail(box, 0)).toMatch(/history on it goes/);
    expect(permanentDeleteDetail({ status: 'hibernated' }, 0)).toMatch(/box is terminated/);
    expect(permanentDeleteDetail({ status: 'failed' }, 0)).toMatch(/box is terminated/);
  });

  it('says a shared box stays, history included, when another project uses it', () => {
    const shared = permanentDeleteDetail(box, 1);
    expect(shared).toMatch(/session is deleted/);
    expect(shared).toMatch(/shared box stays/);
    expect(shared).toMatch(/history on it stays/);
    expect(shared).not.toMatch(/box is terminated/);
    expect(permanentDeleteDetail({ status: 'ready' }, 2)).toMatch(/shared box stays/);
  });

  it('does not claim a missing or already-terminated box is terminated by this delete', () => {
    expect(permanentDeleteDetail(null, 0)).toBe("This session is deleted. This can't be undone.");
    expect(permanentDeleteDetail({ status: 'terminated' }, 0)).toBe("This session is deleted. This can't be undone.");
    expect(permanentDeleteDetail(undefined, 3)).not.toMatch(/shared box/);
  });
});

describe('chatsAfterPermanentDelete', () => {
  const chat = (id: string, boxId: string | null, otherProjects: number) => ({
    id, box: boxId ? { id: boxId } : null, otherProjects, name: id,
  });

  it('drops the deleted chat and recounts a sibling on the same box immediately', () => {
    const next = chatsAfterPermanentDelete(
      [chat('a', 'box-1', 1), chat('b', 'box-1', 1)],
      { id: 'a', boxId: 'box-1' },
    );
    expect(next.map(c => c.id)).toEqual(['b']);
    expect(next[0].otherProjects).toBe(0);
    expect(permanentDeleteDetail({ status: 'stopped' }, next[0].otherProjects)).toMatch(/box is terminated/);
  });

  it('keeps a shared box shared while some other project remains', () => {
    const next = chatsAfterPermanentDelete(
      [chat('a', 'box-1', 2), chat('b', 'box-1', 2), chat('c', 'box-2', 0)],
      { id: 'a', boxId: 'box-1' },
    );
    expect(next.map(c => [c.id, c.otherProjects])).toEqual([['b', 1], ['c', 0]]);
    expect(permanentDeleteDetail({ status: 'stopped' }, next[0].otherProjects)).toMatch(/shared box stays/);
  });

  it('leaves chats on another box, and a chat with no box, uncounted', () => {
    const next = chatsAfterPermanentDelete(
      [chat('a', null, 0), chat('b', 'box-1', 1)],
      { id: 'a', boxId: null },
    );
    expect(next).toEqual([chat('b', 'box-1', 1)]);
    const floor = chatsAfterPermanentDelete([chat('b', 'box-1', 0)], { id: 'missing', boxId: 'box-1' });
    expect(floor[0].otherProjects).toBe(0);
  });
});

describe('deleteLeavesOpenChat', () => {
  it('leaves the page only when the deleted chat is the one on screen', () => {
    expect(deleteLeavesOpenChat('chat-1', 'chat-1')).toBe(true);
    expect(deleteLeavesOpenChat('chat-2', 'chat-1')).toBe(false);
    expect(deleteLeavesOpenChat(null, 'chat-1')).toBe(false);
    expect(deleteLeavesOpenChat(undefined, 'chat-1')).toBe(false);
    expect(deleteLeavesOpenChat('', 'chat-1')).toBe(false);
  });
});

describe('archiveBoxNotice', () => {
  it('leaves when the box is going down, already parked, gone, or absent', () => {
    expect(archiveBoxNotice({ action: 'stop', status: 'stopping' })).toEqual({ leave: true });
    expect(archiveBoxNotice({ action: 'hibernate', status: 'hibernating' })).toEqual({ leave: true });
    expect(archiveBoxNotice({ action: null, reason: 'the chat has no box' })).toEqual({ leave: true });
    expect(archiveBoxNotice({ action: null, reason: 'the box is already stopped' })).toEqual({ leave: true });
    expect(archiveBoxNotice({ action: null, reason: 'the box is already hibernating' })).toEqual({ leave: true });
    expect(archiveBoxNotice({ action: null, reason: 'the box is terminated' })).toEqual({ leave: true });
    expect(archiveBoxNotice({ action: null, reason: 'the box is failed' })).toEqual({ leave: true });
  });

  it('stays and names a still-running box when power fails, and offers the same power again', () => {
    expect(archiveBoxNotice({ action: 'stop', error: 'EC2 refused the stop' })).toEqual({
      leave: false,
      retry: 'stop',
      message: 'This session is archived. Its box is still running: EC2 refused the stop',
    });
    const hibernate = archiveBoxNotice({ action: 'hibernate', error: 'Hibernation is unavailable' });
    expect(hibernate.leave).toBe(false);
    if (!hibernate.leave) expect(hibernate.retry).toBe('hibernate');
  });

  it('stays when the stop was skipped and the box is still up, without a power retry', () => {
    const shared = archiveBoxNotice({ action: null, reason: 'other projects still use this box' });
    expect(shared.leave).toBe(false);
    if (!shared.leave) {
      expect(shared.retry).toBeNull();
      expect(shared.message).toMatch(/still running/);
      expect(shared.message).toMatch(/other projects/);
      expect(shared.message).not.toMatch(/box stops/);
    }
    const host = archiveBoxNotice({ action: null, reason: 'a self-managed host is not powered from termag' });
    expect(host.leave).toBe(false);
    if (!host.leave) expect(host.message).toMatch(/still running/);
    const booting = archiveBoxNotice({ action: null, reason: 'the box is provisioning' });
    expect(booting.leave).toBe(false);
    if (!booting.leave) {
      expect(booting.retry).toBeNull();
      expect(booting.message).toMatch(/still running/);
      expect(booting.message).toMatch(/full UI/);
    }
  });
});
