import React, { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react';
import { contextLevel } from '../utils/thresholds';
import { createPortal } from 'react-dom';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ConfirmDialog, type ConfirmTone } from './ConfirmDialog';
import { BoxLifecycleDialog } from './BoxLifecycleDialog';
import { BoxSpacesDialog } from './BoxSpacesDialog';
import { SpaceDialog } from './SpaceDialog';
import { autoTerminatedText, lifecycleNote, offersAutoHibernate } from '../utils/boxLifecycle';
import { SwitchAgentDialog } from './SwitchAgentDialog';
import { HandoffDialog } from './HandoffDialog';
import { canHandOff } from '../utils/handoff';
import { ShareToSlackDialog, type ShareDraft } from './ShareToSlackDialog';
import { StatusDot } from './StatusDot';
import { RecentsDropdown } from './RecentsDropdown';
import { SearchPalette } from './SearchPalette';
import { StatusStrip } from './StatusStrip';
import { WorktreePrPills, useWorktreePills } from './WorktreePrPills';
import { NewProjectDialog } from './NewProjectDialog';
import { DOCS_SITE_URL } from '../pages/settings/settingsDocs';
import { writeOptOut } from '../mobile/redirect';
import { Project, ProjectInvite, ProjectShareInfo, AgentStatusValue, Instance, AutoTerminatedBox, Workstream, CloudSession, HandoffMode } from '../types';
import { PROVIDERS, SELECTABLE_PROVIDER_IDS, isSelectableProvider, runningProviderForSource } from '../providers/registry';
import { useProjects } from '../contexts/ProjectContext';
import { useAuth } from '../contexts/AuthContext';
import { useConnection } from '../contexts/ConnectionContext';
import { projectsApi, agentTokensApi, sharingApi, instancesApi, workstreamsApi, metatermApi, warmPoolApi, collabApi, handoffApi, AgentTokenInfo, WarmPoolStatus } from '../services/api';
import { claudeSessionsApi, spacesApi, type SpaceView } from '../services/api';
import { errorMessage } from '../services/spaceTransfer';
import { formatBytes as formatSpaceBytes, SPACE_NAME_HINT, SPACE_NAME_RE } from '../utils/spaces';
import { cloudSessionFeed } from '../services/cloudSessionFeed';
import { cloudByBox, cloudCountLabel, cloudDotStatus, cloudElsewhere, cloudLabel, cloudStateLabel, cloudTitle, platformLabel } from '../utils/cloudSessions';
import { FLAGS, useFlag } from '../flags';
import { useTheme } from '../theme/ThemeProvider';
import { metatermVisibility } from '../utils/metatermVisibility';
import { sessionName as buildSessionName } from '../utils/sessionName';
import { boxImageBadge, boxNameTitle } from '../utils/boxImage';
import { statusKey } from '../utils/statusKey';
import { flashesTransition } from '../utils/statusFlash';
import { shouldShowPrPrompt } from '../utils/prPrompt';
import {
  SEEN_STOPS_KEY, formatStopAge, markSeen, mergeSeenStops, readSeenStops, unseenStopAge, writeSeenStops,
  type SeenStops, type UnseenAge,
} from '../utils/unseenStops';
import { aggregateReviewRing, reviewRingTooltip, ringStateFor, type RingState } from '../utils/reviewRing';
import {
  boxDisplay,
  canHibernateBox,
  canStartBox,
  canStopBox,
  hibernationAgeNote,
  isBoxParked,
  showsBoxError,
} from '../utils/boxPower';
import { boxFeed } from '../services/boxFeed';
import { BOX_NAME_ERROR, isValidBoxName } from '../utils/boxNames';
import { REPLAY_BLOCK_CLASS } from '../observability';
import { repoPromptDue } from '../utils/repoPick';
import { CloneProgress } from './CloneProgress';

// Aggregate priority for combining per-workstream statuses into a single
// project-row signal: "is anything alive on this project?"
// The strongest unseen-stop marker of a project's workstreams wins its row.
const UNSEEN_RANK: Record<UnseenAge, number> = { old: 1, recent: 2, fresh: 3 };

const STATUS_PRIORITY: Record<AgentStatusValue, number> = {
  working: 4,
  waiting: 3,
  idle: 2,
  not_running: 1,
};

// Deterministic hue from a box's instance id so a project's "which box" stripe
// stays the same across reloads. Fixed saturation/lightness keeps the visual
// weight consistent against the dark theme. Returns null for legacy projects
// (instanceId === null) so they render with no stripe.
function boxStripeColor(instanceId: string | null | undefined): string | null {
  if (!instanceId) return null;
  let h = 0;
  for (let i = 0; i < instanceId.length; i++) {
    h = (h * 31 + instanceId.charCodeAt(i)) >>> 0;
  }
  return `hsl(${h % 360}, 55%, 58%)`;
}

/** One-line status rollup for the collapsed boxes expander: "2 ready · 1 provisioning". */
const BOX_SUMMARY_LABELS: Record<string, string> = {
  ready: 'ready', provisioning: 'provisioning', 'awaiting-agent': 'awaiting agent',
  starting: 'starting', stopping: 'stopping', stopped: 'stopped',
  hibernating: 'hibernating', hibernated: 'hibernated', failed: 'failed',
};
const BOX_SUMMARY_ORDER = [
  'ready', 'provisioning', 'awaiting-agent', 'starting', 'stopping', 'stopped', 'hibernating', 'hibernated', 'failed',
];
/** "3m", "2h", "1d": how long a cloud session has been where it is. */
function fmtAgeShort(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function boxSummary(boxes: Instance[], cloudSessions = 0): string {
  if (boxes.length === 0) return '';
  const counts = new Map<string, number>();
  for (const b of boxes) counts.set(b.status, (counts.get(b.status) ?? 0) + 1);
  const parts = BOX_SUMMARY_ORDER.filter(s => counts.has(s)).map(s => `${counts.get(s)} ${BOX_SUMMARY_LABELS[s]}`);
  if (cloudSessions > 0) parts.push(cloudCountLabel(cloudSessions));
  return parts.join(' · ');
}

export function ProjectControl() {
  const { user, updateDefaultAgentProvider } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    projects, activeProjectId, statusMap, setActiveProject, reloadProjects, settleProjectClone,
    getActiveWorkstream, setActiveWorkstream,
  } = useProjects();
  // "New project" opens the shared NewProjectForm in a dialog (NewProjectDialog).
  const [showNewProject, setShowNewProject] = useState(false);
  // Each worktree's pull requests, as pills on its row.
  const prPillsFor = useWorktreePills();
  const [repoPromptBoxId, setRepoPromptBoxId] = useState<string | undefined>();
  const repoPickerOn = useFlag(FLAGS.repoFirstPicker, false);
  const simpleUi = useFlag(FLAGS.simpleUi, false);
  // MetaTerm is opt-in (Settings → Appearance): on a first run its sidebar
  // entry reads like a place to work, and people ended up on the orchestrator.
  const { theme } = useTheme();
  // Settings picker: a stored default that is no longer selectable (e.g. codex) is
  // rendered as a disabled "current" option so the select's value equals the stored
  // value — otherwise picking Claude would equal the displayed value, never fire
  // onChange, and the legacy default could never be changed to Claude.
  const storedDefault = user?.defaultAgentProvider && PROVIDERS[user.defaultAgentProvider] ? user.defaultAgentProvider : 'claude';
  const legacyDefault = isSelectableProvider(storedDefault) ? null : storedDefault;
  const [error, setError] = useState('');
  const [cloneBusyId, setCloneBusyId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // Closing the inline rename input (Enter, Escape, or a successful save)
  // unmounts it, and the unmount fires onBlur with the stale closure. Without
  // this guard Enter submits twice and Escape saves instead of discarding.
  const renameSettled = useRef(false);
  function beginRename(id: string, value: string) {
    renameSettled.current = false;
    setRenamingId(id);
    setRenameValue(value);
  }
  function cancelRename() {
    renameSettled.current = true;
    setRenamingId(null);
  }
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<{ message: string; onConfirm: () => void; confirmLabel?: string; tone?: ConfirmTone } | null>(null);
  // Switch agent dialog: which workstream it is for, and whether a switch is in flight.
  const [switchTarget, setSwitchTarget] = useState<{ project: Project; ws: Workstream } | null>(null);
  // Hand off: the workstream whose agent the dialog is for.
  const [handoffTarget, setHandoffTarget] = useState<{ project: Project; ws: Workstream } | null>(null);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffError, setHandoffError] = useState('');
  const [shareTarget, setShareTarget] = useState<{ project: Project; ws: Workstream } | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState('');
  const [shareSent, setShareSent] = useState<string | null>(null);
  const [switchBusy, setSwitchBusy] = useState(false);

  // Multiselect edit mode: a "Select" toggle flips owned project rows into
  // checkbox mode for bulk pin/unpin. Collaborator rows aren't pinnable, so
  // they stay unselectable.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
  }, []);

  async function bulkSetPinned(pinned: boolean) {
    if (selectedIds.size === 0) return;
    try {
      await projectsApi.bulkPin([...selectedIds], pinned);
      await reloadProjects();
      exitSelectMode();
    } catch {
      setError('Failed to update pins');
    }
  }

  // Track status transitions for highlight flash
  const prevStatusRef = useRef<Record<string, AgentStatusValue>>({});
  // Same lattice for the review ring: a transition INTO a ready review fires
  // the tile's flash in blue.
  const prevReviewRef = useRef<Record<string, RingState | null>>({});
  const mountedAtRef = useRef(Date.now());
  // Map of project id → status it transitioned to (for coloring the flash);
  // 'review-ready' is the ring's blue variant.
  const [flashingProjects, setFlashingProjects] = useState<Map<string, AgentStatusValue | 'review-ready'>>(new Map());

  useEffect(() => {
    const prev = prevStatusRef.current;
    const newFlashes = new Map<string, AgentStatusValue | 'review-ready'>();
    // Skip flashes during initial WebSocket state sync (first 3s after mount)
    const settled = Date.now() - mountedAtRef.current > 3000;

    for (const p of projects) {
      // Track aggregate per-project (was per-session). Same flash UX, but the
      // project row reflects whichever workstream is most alive rather than
      // staying red while a non-main workstream does the work.
      const currentStatus = aggregateStatus(p);
      const prevStatus = prev[p.id];
      if (settled && flashesTransition(prevStatus, currentStatus)) {
        newFlashes.set(p.id, currentStatus);
      }
      prev[p.id] = currentStatus;

      // The review ring's own flash: once per transition into a ready review
      // (waiting > reviewing > done aggregation), in blue.
      const reviewRing = reviewRingFor(p).ring;
      const prevRing = prevReviewRef.current[p.id];
      if (settled && prevRing !== undefined && reviewRing === 'done' && prevRing !== 'done') {
        newFlashes.set(p.id, 'review-ready');
      }
      prevReviewRef.current[p.id] = reviewRing;
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

  // While the backend is unreachable every status glyph is a frozen snapshot;
  // grey them so a stale green can't pass for a live one.
  const { state: connectionState } = useConnection();
  const statusesStale = connectionState === 'offline';

  // "Stopped since you looked": agent sessions that
  // came to rest after this browser last had them on screen keep a marker
  // until opened. Seen times live in localStorage, per browser.
  const browserStorage = typeof localStorage !== 'undefined' ? localStorage : null;
  const [seenStops, setSeenStops] = useState<SeenStops>(() => readSeenStops(browserStorage, Date.now()));
  const [pageVisible, setPageVisible] = useState(() => typeof document === 'undefined' || !document.hidden);
  // The marker ages (fresh → recent → old → gone) with no status change to re-render it.
  const [stopClock, setStopClock] = useState(() => Date.now());
  useEffect(() => {
    const onVisibility = () => setPageVisible(!document.hidden);
    // Another tab opened something: take its seen times.
    const onStorage = (e: StorageEvent) => {
      if (e.key === SEEN_STOPS_KEY) setSeenStops(readSeenStops(localStorage, Date.now()));
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('storage', onStorage);
    const tick = setInterval(() => setStopClock(Date.now()), 60_000);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('storage', onStorage);
      clearInterval(tick);
    };
  }, []);
  // Every change is applied over what storage holds now, merged with this
  // tab's view, and written at once: another tab may have saved since this
  // one last read, and a stale snapshot must not put its markers back.
  const seenRef = useRef(seenStops);
  seenRef.current = seenStops;
  const updateSeen = useCallback((fn: (s: SeenStops) => SeenStops) => {
    const base = mergeSeenStops(seenRef.current, readSeenStops(browserStorage, Date.now()));
    const next = fn(base);
    writeSeenStops(browserStorage, next);
    seenRef.current = next;
    setSeenStops(next);
  }, [browserStorage]);

  // Seen times are keyed by project and workstream id, not session name, so a
  // project or workstream rename keeps them (the status, stoppedAt included,
  // moves to the new name). main can't be renamed and is keyed by name. Any
  // other workstream has no key until its id is known: a name-keyed mark made
  // before the list loads would be orphaned once the id key takes over.
  function seenKeyOf(project: Project, wsName: string): string | null {
    if (wsName === 'main') return `${project.id}:main`;
    const ws = project.workstreams?.find(w => w.name === wsName);
    return ws ? `${project.id}:${ws.id}` : null;
  }

  // Each agent session of a project with the workstream it belongs to.
  function agentWorkstreamSessions(project: Project): { ws: string; session: string }[] {
    if (!project.workflows.some(w => w.type === 'agent')) return [];
    const owner = project.ownerUsername ?? user?.unixUsername ?? '';
    const wsList = project.workstreams ?? [];
    if (wsList.length === 0) return [{ ws: 'main', session: buildSessionName(owner, project.name, 'agent') }];
    return wsList.map(ws => ({ ws: ws.name, session: buildSessionName(owner, project.name, 'agent', ws.name) }));
  }

  // The session on screen: the active project's active workstream, while the
  // tab is visible. It counts as seen on arrival and again whenever it stops.
  const viewedProject = projects.find(p => p.id === activeProjectId);
  const viewedWs = viewedProject ? getActiveWorkstream(viewedProject.id) : null;
  const viewingKey = viewedProject && viewedWs ? seenKeyOf(viewedProject, viewedWs) : null;
  const viewingStoppedAt = viewedProject && viewedWs
    ? statusMap[statusKey(viewedProject.instanceId, buildSessionName(
      viewedProject.ownerUsername ?? user?.unixUsername ?? '', viewedProject.name, 'agent', viewedWs,
    ))]?.stoppedAt
    : undefined;
  useEffect(() => {
    if (!viewingKey || !pageVisible) return;
    updateSeen(s => markSeen(s, viewingKey, Date.now(), viewingStoppedAt));
  }, [viewingKey, viewingStoppedAt, pageVisible, updateSeen]);

  function unseenStop(project: Project, wsName: string, session: string): UnseenAge | null {
    const key = seenKeyOf(project, wsName);
    if (!key || (key === viewingKey && pageVisible)) return null;
    const st = statusMap[statusKey(project.instanceId, session)];
    return unseenStopAge(seenStops, key, st?.status, st?.stoppedAt, stopClock);
  }

  // Newest first, for the "Stopped since you looked" list.
  const unseenStops = projects.flatMap(p => agentWorkstreamSessions(p).flatMap(({ ws, session }) => {
    const age = unseenStop(p, ws, session);
    if (!age) return [];
    const st = statusMap[statusKey(p.instanceId, session)];
    return [{ project: p, ws, session, age, status: st.status, stoppedAtIso: st.stoppedAt, stoppedAt: Date.parse(st.stoppedAt as string) }];
  })).sort((a, b) => b.stoppedAt - a.stoppedAt);
  const unseenByProject = new Map<string, typeof unseenStops>();
  for (const u of unseenStops) unseenByProject.set(u.project.id, [...(unseenByProject.get(u.project.id) ?? []), u]);

  function markAllStopsSeen() {
    const now = Date.now();
    updateSeen(s => unseenStops.reduce((acc, u) => {
      const key = seenKeyOf(u.project, u.ws);
      return key ? markSeen(acc, key, now, u.stoppedAtIso) : acc;
    }, s));
  }

  // Workstream first: setActiveProject writes ?ws= from the remembered
  // workstream, and setActiveWorkstream only touches the URL of the project
  // that is already active (same order as the Recents switcher).
  // Within the open project only the workstream changes: setActiveProject
  // would push a history entry for every workstream switch.
  function openWorkstream(projectId: string, wsName: string) {
    setActiveWorkstream(projectId, wsName);
    if (projectId !== activeProjectId) setActiveProject(projectId);
  }


  // Sharing / invites
  const [invites, setInvites] = useState<ProjectInvite[]>([]);
  const [shareProjectId, setShareProjectId] = useState<string | null>(null);
  const [shareEmail, setShareEmail] = useState('');
  const [shares, setShares] = useState<ProjectShareInfo[]>([]);

  const [branchOffProjectId, setBranchOffProjectId] = useState<string | null>(null);
  useEffect(() => {
    if (searchParams.get('branchOff') !== '1') return;
    const id = searchParams.get('project');
    if (id) setBranchOffProjectId(id);
    const next = new URLSearchParams(searchParams);
    next.delete('branchOff');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  const [newWorkstreamName, setNewWorkstreamName] = useState('');

  // Load pending invites on mount
  useEffect(() => {
    if (user) sharingApi.listInvites().then(data => {
      if (Array.isArray(data)) setInvites(data);
    }).catch(() => {});
  }, [user]);

  // Track which owned projects have active shares
  const [sharedProjectIds, setSharedProjectIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!user) return;
    const ownedProjects = projects.filter(p => p.role !== 'collaborator');
    Promise.all(ownedProjects.map(p =>
      sharingApi.listShares(p.id).then(data => Array.isArray(data) && data.length > 0 ? p.id : null).catch(() => null)
    )).then(results => {
      setSharedProjectIds(new Set(results.filter(Boolean) as string[]));
    });
  }, [projects, user]);

  // Load shares when share panel opens
  useEffect(() => {
    if (shareProjectId) {
      sharingApi.listShares(shareProjectId).then(data => {
        if (Array.isArray(data)) setShares(data); else setShares([]);
      }).catch(() => setShares([]));
    }
  }, [shareProjectId]);

  // Boxes (compute instances)
  const boxes = useSyncExternalStore(boxFeed.subscribe, boxFeed.getSnapshot);
  const boxesLoaded = useSyncExternalStore(boxFeed.subscribe, boxFeed.hasLoaded);
  // Claude Code cloud sessions on those boxes,
  // behind the flag; App starts the feed. Owner only.
  const cloudSessionsOn = useFlag(FLAGS.cloudSessions, false);
  const cloudAll = useSyncExternalStore(cloudSessionFeed.subscribe, cloudSessionFeed.getSnapshot);
  const cloud = cloudSessionsOn ? cloudByBox(cloudAll) : { byBox: new Map<string, CloudSession[]>(), queued: [] as CloudSession[] };
  const cloudActiveCount = cloudSessionsOn ? [...cloud.byBox.values()].reduce((n, l) => n + l.length, 0) + cloud.queued.length : 0;
  const [cloudMenuKey, setCloudMenuKey] = useState<string | null>(null);
  const [cloudLog, setCloudLog] = useState<{ title: string; log: string } | null>(null);
  const [cloudError, setCloudError] = useState('');
  // Rename: the title after the fixed "Claude Cloud N" name, edited inline.
  // Same guard as the project rename above: closing the input fires onBlur
  // with the stale closure, so Enter would submit twice and Escape would save.
  const [cloudRenameKey, setCloudRenameKey] = useState<string | null>(null);
  const [cloudRenameValue, setCloudRenameValue] = useState('');
  const cloudRenameSettled = useRef(false);
  /** A title lives on a run row; a queued session has none yet. */
  const canRenameCloud = (s: CloudSession) => s.current != null || s.runs.length > 0;
  const beginCloudRename = (s: CloudSession) => { cloudRenameSettled.current = false; setCloudRenameKey(s.key); setCloudRenameValue(s.title ?? ''); };
  const cancelCloudRename = () => { cloudRenameSettled.current = true; setCloudRenameKey(null); };
  const commitCloudRename = async (s: CloudSession) => {
    if (cloudRenameSettled.current) return;
    cloudRenameSettled.current = true;
    const next = cloudRenameValue.trim();
    setCloudRenameKey(null);
    if (next === (s.title ?? '')) return;
    try { await claudeSessionsApi.rename(s.key, next || null); await cloudSessionFeed.reload(); }
    catch (err) { setCloudError((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not rename the session'); }
  };
  const endCloudSession = (s: CloudSession) => {
    setConfirmState({
      message: `End ${cloudLabel(s)} on ${s.current?.boxName ?? 'its box'}? The runner releases it; it parks on claude.ai and can be resumed from there.`,
      confirmLabel: 'End session',
      tone: 'primary',
      onConfirm: async () => {
        setConfirmState(null);
        try { await claudeSessionsApi.end(s.key); await cloudSessionFeed.reload(); }
        catch (err) { setCloudError((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not end the session'); }
      },
    });
  };
  const showCloudLog = async (s: CloudSession) => {
    try {
      const r = await claudeSessionsApi.runnerLog(s.key, 200);
      setCloudLog({ title: `${cloudLabel(s)} · runner log (${r.orderId})`, log: r.log });
    } catch (err) {
      setCloudError((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not read the runner log');
    }
  };
  // Self-managed (external) box registration; EC2 boxes are created from the
  // New project dialog, which waits for them (and carries the GitHub gate).
  const [newBoxName, setNewBoxName] = useState('');
  const [boxError, setBoxError] = useState('');
  const [boxMenuOpenId, setBoxMenuOpenId] = useState<string | null>(null);
  // Set after creating a self-managed box: the one-time token + config to paste
  // into agent.config.json on the user's own machine.
  const [createdBox, setCreatedBox] = useState<{ name: string; token: string; agentWsUrl?: string } | null>(null);
  const warmPoolEnabled = useFlag(FLAGS.warmPool, false);
  const autoLifecycleOn = useFlag(FLAGS.autoLifecycle, false);
  const boxSharingOn = useFlag(FLAGS.boxSharing, false);
  const slackCollabOn = useFlag(FLAGS.slackCollab, false);
  const handoffOn = useFlag(FLAGS.agentHandoff, false);
  const [lifecycleBox, setLifecycleBox] = useState<Instance | null>(null);
  const [autoTerminated, setAutoTerminated] = useState<AutoTerminatedBox[]>([]);
  const [warmPool, setWarmPool] = useState<WarmPoolStatus | null>(null);
  const [claimLog, setClaimLog] = useState<{ boxName: string; log: string } | null>(null);
  // The Boxes section starts collapsed (same pattern as the Agent tokens
  // section); a fresh self-managed token or a box error must be visible
  // immediately, so those auto-expand it.
  const [showBoxes, setShowBoxes] = useState(false);
  useEffect(() => { if (createdBox || boxError) setShowBoxes(true); }, [createdBox, boxError]);

  const reloadBoxes = boxFeed.reload;

  // Spaces, only with the flag on: off, nothing is fetched.
  const spacesOn = useFlag(FLAGS.spaces, false);
  const [spaces, setSpaces] = useState<SpaceView[]>([]);
  const [showSpaces, setShowSpaces] = useState(false);
  const [openSpace, setOpenSpace] = useState<SpaceView | null>(null);
  const [boxSpaces, setBoxSpaces] = useState<Instance | null>(null);
  const [newSpaceName, setNewSpaceName] = useState('');
  const [spacesError, setSpacesError] = useState('');
  const reloadSpaces = useCallback(async () => {
    try {
      setSpaces((await spacesApi.list()).spaces);
    } catch (err) {
      setSpacesError(errorMessage(err, 'Could not load spaces'));
    }
  }, []);
  useEffect(() => {
    if (!user || !spacesOn) { setSpaces([]); return; }
    void reloadSpaces();
  }, [user, spacesOn, reloadSpaces]);
  const createSpace = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newSpaceName.trim();
    if (!SPACE_NAME_RE.test(name)) { setSpacesError(`A space name is ${SPACE_NAME_HINT}`); return; }
    try {
      const { space } = await spacesApi.create(name);
      setNewSpaceName('');
      setSpacesError('');
      await reloadSpaces();
      setOpenSpace(space);
    } catch (err) {
      setSpacesError(errorMessage(err, 'Could not create the space'));
    }
  };

  // Pool depth for the "N warm, N warming" line and the Add box hint, only with
  // the flag on (off, nothing is fetched). Refreshed with each box feed update,
  // as the box list's own reload used to refresh it.
  useEffect(() => {
    if (!user || !warmPoolEnabled) {
      setWarmPool(null);
      return;
    }
    let cancelled = false;
    warmPoolApi.get().then(p => { if (!cancelled) setWarmPool(p); }).catch(() => { /* keep the last line */ });
    return () => { cancelled = true; };
  }, [user, warmPoolEnabled, boxes]);

  // Boxes the lifecycle sweep terminated this week; a terminated box leaves the
  // list, so refetched when the list shrinks or grows rather than on every poll.
  useEffect(() => {
    if (!user || !autoLifecycleOn) {
      setAutoTerminated([]);
      return;
    }
    let cancelled = false;
    instancesApi.autoTerminated().then(list => { if (!cancelled) setAutoTerminated(list); }).catch(() => { /* keep the last list */ });
    return () => { cancelled = true; };
  }, [user, autoLifecycleOn, boxes.length]);

  // App keeps the feed polling through transitions; refresh on mount so a
  // list reopened after the sidebar was collapsed starts current.
  useEffect(() => {
    if (user) void boxFeed.reload();
  }, [user]);

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


  // List of all the agent tmux session names for a project, one per workstream
  // (with `main` collapsing to the historical 3-segment name). Falls back to
  // the historical single-session shape if workstreams haven't loaded yet.
  function projectAgentSessions(project: Project): string[] {
    const owner = project.ownerUsername ?? user?.unixUsername ?? '';
    const wsList = project.workstreams ?? [];
    if (wsList.length === 0) return [buildSessionName(owner, project.name, 'agent')];
    return wsList.map(ws => buildSessionName(owner, project.name, 'agent', ws.name));
  }

  // Project-row status aggregates across all workstreams: the worst-priority
  // signal wins, so a project flips to working/waiting whenever any of its
  // workstreams does. Per-workstream icons in the sub-list disambiguate which
  // one is actually doing the work.
  function aggregateStatus(project: Project): AgentStatusValue {
    if (!project.workflows.some(w => w.type === 'agent')) return 'not_running';
    let best: AgentStatusValue = 'not_running';
    for (const s of projectAgentSessions(project)) {
      const cur = statusMap[statusKey(project.instanceId, s)]?.status ?? 'not_running';
      if (STATUS_PRIORITY[cur] > STATUS_PRIORITY[best]) best = cur;
    }
    return best;
  }

  function statusGlyph(project: Project): React.ReactNode {
    if (!project.workflows.some(w => w.type === 'agent')) return '—';
    return <StatusDot status={aggregateStatus(project)} />;
  }

  // Any workstream of the project with a live "PR opened — compact or clear?"
  // prompt. Same gate as the card over the pane, so the glyph and the card
  // appear and disappear together.
  function prPromptPendingSession(instanceId: string | null | undefined, session: string): boolean {
    const st = statusMap[statusKey(instanceId, session)];
    return shouldShowPrPrompt({ status: st?.status, milestone: st?.milestone, contextTokens: st?.contextTokens, now: Date.now() });
  }
  function prPromptPending(project: Project): boolean {
    if (!project.workflows.some(w => w.type === 'agent')) return false;
    return projectAgentSessions(project).some(s => prPromptPendingSession(project.instanceId, s));
  }

  // The Devin review ring for one workstream and the
  // tile's aggregation over them (waiting > reviewing > done). pr is the PR
  // of whichever workstream owns the aggregated state, for the tooltip.
  function reviewRingSession(instanceId: string | null | undefined, session: string): { ring: RingState | null; pr: number | null; reviewer: string | null } {
    const st = statusMap[statusKey(instanceId, session)];
    const review = st?.review ?? null;
    return { ring: ringStateFor(review), pr: review?.pr ?? null, reviewer: review?.reviewer ?? null };
  }
  function reviewRingFor(project: Project): { ring: RingState | null; pr: number | null; reviewer: string | null } {
    if (!project.workflows.some(w => w.type === 'agent')) return { ring: null, pr: null, reviewer: null };
    const entries = projectAgentSessions(project).map(s => reviewRingSession(project.instanceId, s));
    const ring = aggregateReviewRing(entries.map(e => e.ring));
    if (!ring) return { ring: null, pr: null, reviewer: null };
    const top = entries.find(e => e.ring === ring);
    return { ring, pr: top?.pr ?? null, reviewer: top?.reviewer ?? null };
  }

  function contextWarning(project: Project): { level: 'ok' | 'warn' | 'danger'; tokens: number } | null {
    if (!project.workflows.some(w => w.type === 'agent')) return null;
    // Take the worst (highest tokens) across workstreams — that's the one
    // about to bite.
    let max = 0;
    for (const s of projectAgentSessions(project)) {
      const t = statusMap[statusKey(project.instanceId, s)]?.contextTokens;
      if (t && t > max) max = t;
    }
    const level = contextLevel(max);
    if (level === 'ok') return null;
    return { level, tokens: max };
  }

  function rateLimitWarning(project: Project): string | null {
    if (!project.workflows.some(w => w.type === 'agent')) return null;
    for (const s of projectAgentSessions(project)) {
      const r = statusMap[statusKey(project.instanceId, s)]?.rateLimited;
      if (r) return r;
    }
    return null;
  }

  function fmtTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    return `${Math.round(n / 1000)}K`;
  }

  // The persisted provider of one workstream's agent workflow (set at project
  // creation / branch-off; nothing rewrites it when a different agent starts).
  function persistedWorkstreamProvider(project: Project, workstreamId: string | undefined): string | null {
    return project.workflows.find(w => w.type === 'agent' && (workstreamId === undefined || w.workstreamId === workstreamId))?.provider ?? null;
  }

  // What one workstream is actually running: the live status `source` of its
  // own agent session mapped back through the registry, falling back to the
  // persisted workflow provider.
  function workstreamAgentProvider(project: Project, ws: Workstream): string | null {
    const owner = project.ownerUsername ?? user?.unixUsername ?? '';
    const source = statusMap[statusKey(project.instanceId, buildSessionName(owner, project.name, 'agent', ws.name))]?.source;
    const live = runningProviderForSource(source);
    return live ?? persistedWorkstreamProvider(project, ws.id);
  }

  // The project badge is the main workstream's provider — deterministic,
  // unlike taking the first live source across workstreams, which followed
  // whichever workstream's agent reported most recently. Mixed setups carry
  // per-workstream badges on the sub-rows.
  function displayAgentProvider(project: Project): string | null {
    const main = project.workstreams.find(ws => ws.name === 'main') ?? project.workstreams[0];
    if (!main) return persistedWorkstreamProvider(project, undefined);
    return workstreamAgentProvider(project, main);
  }

  // "also: pi on feature-x" for the project badge tooltip when
  // workstreams run mixed providers.
  function mixedProviderNote(project: Project, mainProvider: string | null): string {
    const others = new Map<string, string>(); // provider → first workstream using it
    for (const ws of project.workstreams) {
      const prov = workstreamAgentProvider(project, ws);
      if (prov && prov !== mainProvider && !others.has(prov)) others.set(prov, ws.name);
    }
    if (others.size === 0) return '';
    const parts = [...others.entries()].map(([prov, ws]) => `${PROVIDERS[prov]?.displayName ?? prov} on ${ws}`);
    return ` · also: ${parts.join(', ')}`;
  }

  async function acceptInvite(inviteId: string) {
    try {
      await sharingApi.acceptInvite(inviteId);
      setInvites(prev => prev.filter(i => i.id !== inviteId));
      await reloadProjects();
    } catch { setError('Failed to accept invite'); }
  }

  async function declineInvite(inviteId: string) {
    try {
      await sharingApi.declineInvite(inviteId);
      setInvites(prev => prev.filter(i => i.id !== inviteId));
    } catch { setError('Failed to decline invite'); }
  }

  async function sendInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!shareProjectId || !shareEmail.trim()) return;
    try {
      await sharingApi.invite(shareProjectId, shareEmail.trim());
      setShareEmail('');
      setError('');
      // Refresh shares list
      const updated = await sharingApi.listShares(shareProjectId);
      setShares(updated);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || 'Failed to send invite');
    }
  }

  async function revokeShare(shareId: string) {
    if (!shareProjectId) return;
    try {
      await sharingApi.revokeShare(shareProjectId, shareId);
      const remaining = shares.filter(s => s.id !== shareId);
      setShares(remaining);
      if (remaining.length === 0) {
        setSharedProjectIds(prev => { const next = new Set(prev); next.delete(shareProjectId!); return next; });
        // With new shares off the panel has nothing left to show.
        if (!boxSharingOn) setShareProjectId(null);
      }
    } catch { setError('Failed to revoke share'); }
  }

  function leaveProject(projectId: string) {
    setConfirmState({
      message: 'Leave this shared project?',
      confirmLabel: 'Leave',
      onConfirm: async () => {
        try {
          await sharingApi.leaveProject(projectId);
          if (activeProjectId === projectId) setActiveProject(null);
          await reloadProjects();
        } catch { setError('Failed to leave project'); }
      },
    });
  }

  // MetaTerm: idempotent open — creates the pinned singleton on first use,
  // then just focuses it. Mirrors the New project dialog's create-then-open sequence.
  const [metatermBusy, setMetatermBusy] = useState(false);
  async function openMetaTerm() {
    if (metatermBusy) return;
    setMetatermBusy(true);
    try {
      const { project } = await metatermApi.open();
      setError('');
      await reloadProjects();
      setActiveProject(project.id);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || 'Failed to open MetaTerm');
    } finally {
      setMetatermBusy(false);
    }
  }

  async function runClone(project: Project, action: 'retry' | 'start-empty') {
    if (cloneBusyId) return;
    setCloneBusyId(project.id);
    setError('');
    try {
      await settleProjectClone(project.id, action);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || (action === 'retry' ? 'Failed to retry the clone' : 'Failed to start empty'));
    } finally {
      setCloneBusyId(null);
    }
  }

  async function renameProject(project: Project) {
    if (renameSettled.current) return;
    renameSettled.current = true;
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

  // Workstream rename shares renamingId/renameValue/menuOpenId with the project
  // menu: ids are globally unique cuids, so a workstream id never collides with
  // a project id and the two inline editors cannot both be open.
  async function renameWorkstream(project: Project, ws: { id: string; name: string }) {
    if (renameSettled.current) return;
    renameSettled.current = true;
    const newName = renameValue.trim();
    if (!newName || newName === ws.name) { setRenamingId(null); return; }
    try {
      await workstreamsApi.rename(project.id, ws.id, newName);
      setRenamingId(null);
      setRenameValue('');
      if (getActiveWorkstream(project.id) === ws.name) setActiveWorkstream(project.id, newName);
      await reloadProjects();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || 'Failed to rename workstream');
      setRenamingId(null);
    }
  }

  function archiveProject(project: Project) {
    setConfirmState({
      message: `Archive ${project.name}? This will kill all tmux sessions for this project.`,
      confirmLabel: 'Archive',
      onConfirm: async () => {
        await projectsApi.archive(project.id);
        if (activeProjectId === project.id) setActiveProject(null);
        await reloadProjects();
      },
    });
  }

  async function togglePin(project: Project) {
    await projectsApi.togglePin(project.id);
    await reloadProjects();
  }

  async function createWorkstream(e: React.FormEvent, projectId: string) {
    e.preventDefault();
    const name = newWorkstreamName.trim();
    if (!name) return;
    try {
      const ws = await workstreamsApi.create(projectId, { name });
      setNewWorkstreamName('');
      setBranchOffProjectId(null);
      await reloadProjects();
      // Auto-switch to the freshly-created workstream — branching off without
      // jumping to the new line feels wrong.
      setActiveWorkstream(projectId, ws.name);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } }).response?.data?.error;
      setError(msg ?? 'Failed to create workstream');
    }
  }

  // The agent a switch would replace: the STORED one, not the live status
  // source. They differ exactly when someone started a different CLI by hand
  // (the case this action exists for), and the row is what the switch fixes.
  function storedWorkstreamProvider(project: Project, ws: Workstream): string {
    return persistedWorkstreamProvider(project, ws.id) ?? user?.defaultAgentProvider ?? 'claude';
  }

  function workstreamHasAgent(project: Project, ws: Workstream | undefined): ws is Workstream {
    return !!ws && project.workflows.some(w => w.workstreamId === ws.id && w.type === 'agent');
  }

  async function shareToSlack(draft: ShareDraft) {
    if (!shareTarget || shareBusy) return;
    const { project, ws } = shareTarget;
    setShareBusy(true);
    setShareError('');
    try {
      const r = await collabApi.send({ projectId: project.id, workstream: ws.name, ...draft });
      setShareSent(r.permalink ?? '');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setShareError(msg ?? 'Failed to send to Slack');
    } finally {
      setShareBusy(false);
    }
  }

  async function switchAgent(provider: string) {
    if (!switchTarget || switchBusy) return;
    const { project, ws } = switchTarget;
    setSwitchBusy(true);
    try {
      const result = await workstreamsApi.switchAgent(project.id, ws.id, provider);
      setSwitchTarget(null);
      // Recorded, but not typed into the pane (probe failed, git busy): say so.
      if (result.warning) setError(result.warning);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setSwitchTarget(null);
      setError(msg ?? 'Failed to switch agent');
    } finally {
      setSwitchBusy(false);
      // Reload either way: a launch that failed after the switch still recorded the new agent.
      await reloadProjects();
    }
  }

  async function startHandoff(body: { mode: HandoffMode; provider?: string; note?: string }) {
    if (!handoffTarget || handoffBusy) return;
    const { project, ws } = handoffTarget;
    setHandoffBusy(true);
    setHandoffError('');
    try {
      const result = await handoffApi.start(project.id, ws.id, body);
      setHandoffTarget(null);
      // The asked-for mode fell back (an agent with no /clear restarts): say so.
      if (result.note) setError(result.note);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setHandoffError(msg ?? 'Failed to start the handoff');
    } finally {
      setHandoffBusy(false);
    }
  }

  function deleteWorkstream(project: Project, ws: { id: string; name: string }) {
    setConfirmState({
      message: `Delete workstream "${ws.name}"? Removes the worktree and its branch (refuses on unmerged work).`,
      confirmLabel: 'Delete',
      onConfirm: async () => {
        try {
          const result = await workstreamsApi.remove(project.id, ws.id);
          if (result.branchDeleteWarning) {
            setError(`Workstream removed, but branch cleanup warned: ${result.branchDeleteWarning}`);
          }
          if (getActiveWorkstream(project.id) === ws.name) {
            setActiveWorkstream(project.id, 'main');
          }
          await reloadProjects();
        } catch (err: unknown) {
          const msg = (err as { response?: { data?: { error?: string } } }).response?.data?.error;
          setError(msg ?? 'Failed to delete workstream');
        }
      },
    });
  }

  async function registerSelfManagedBox(e: React.FormEvent) {
    e.preventDefault();
    if (!newBoxName.trim()) return;
    if (!isValidBoxName(newBoxName.trim())) { setBoxError(BOX_NAME_ERROR); return; }
    try {
      const result = await instancesApi.create(newBoxName.trim(), 'external');
      // Self-managed boxes return a one-time token to paste into the agent
      // config on the user's own machine.
      if (result.token) {
        setCreatedBox({ name: result.instance.name, token: result.token, agentWsUrl: result.agentWsUrl });
      }
      setNewBoxName('');
      setBoxError('');
      await reloadBoxes();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setBoxError(msg || 'Failed to register box');
    }
  }

  function terminateBox(box: Instance) {
    const doTerminate = async (confirmed: boolean) => {
      try {
        await instancesApi.terminate(box.id, confirmed);
        await reloadBoxes();
      } catch (err: unknown) {
        // 409 → box has live projects; re-confirm to archive them all.
        const resp = (err as { response?: { status?: number; data?: { projects?: Array<{ name: string }> } } })?.response;
        if (resp?.status === 409) {
          const names = (resp.data?.projects ?? []).map(p => p.name).join(', ');
          setConfirmState({
            message: `"${box.name}" has live projects (${names}). Terminate anyway? This archives them all.`,
            confirmLabel: 'Terminate',
            onConfirm: () => doTerminate(true),
          });
        } else {
          setBoxError('Failed to terminate box');
        }
      }
    };
    setConfirmState({
      message: box.kind === 'external'
        ? `Remove box "${box.name}"? This revokes its token; stop the agent on that machine.`
        : `Terminate box "${box.name}"? This destroys the EC2 instance.`,
      confirmLabel: box.kind === 'external' ? 'Remove box' : 'Terminate',
      onConfirm: () => doTerminate(false),
    });
  }

  function stopBox(box: Instance) {
    const count = box._count?.projects ?? 0;
    setConfirmState({
      message: `Stop box "${box.name}"? Running agents${count ? ` in its ${count} project${count === 1 ? '' : 's'}` : ''} `
        + 'will be interrupted. Files and agent conversations stay on its disk, and its sessions are '
        + 'recreated when you start it again. A stopped box costs only its disk.',
      confirmLabel: 'Stop box',
      tone: 'primary',
      onConfirm: async () => {
        try {
          await instancesApi.stop(box.id);
          setBoxError('');
        } catch (err: unknown) {
          const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
          setBoxError(msg || 'Failed to stop box');
        }
        await reloadBoxes();
      },
    });
  }

  function hibernateBox(box: Instance) {
    setConfirmState({
      message: `Hibernate box "${box.name}"? EC2 saves the box's memory to its disk and powers the instance off, so `
        + 'agents, tmux sessions, dev servers and containers resume exactly where they were when you start it. '
        + 'Network connections (port forwards, SSO and SSH sessions) drop and reconnect. '
        + 'A hibernated box costs only its disk; after 55 days termag resumes and re-hibernates it, '
        + "since EC2 doesn't keep a box hibernated longer than 60.",
      confirmLabel: 'Hibernate',
      tone: 'primary',
      onConfirm: async () => {
        try {
          const { status } = await instancesApi.hibernate(box.id);
          setBoxError(status === 'stopping'
            ? 'EC2 would not hibernate this box right now, so it was stopped instead. Its sessions are recreated when you start it.'
            : '');
        } catch (err: unknown) {
          const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
          setBoxError(msg || 'Failed to hibernate box');
        }
        await reloadBoxes();
      },
    });
  }

  async function dismissRepoPrompt(box: Instance) {
    try {
      const row = await instancesApi.dismissRepoPrompt(box.id);
      boxFeed.upsert({ ...box, repoPromptDismissedAt: row.repoPromptDismissedAt ?? null });
      setBoxError('');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setBoxError(msg || 'Could not dismiss the prompt');
    }
  }

  async function startBox(box: Instance) {
    try {
      await instancesApi.start(box.id);
      setBoxError('');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setBoxError(msg || 'Failed to start box');
    }
    await reloadBoxes();
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

  function revokeToken(id: string) {
    setConfirmState({
      message: 'Revoke this token? The agent using it will be disconnected.',
      confirmLabel: 'Revoke',
      onConfirm: async () => {
        await agentTokensApi.revoke(id);
        setTokens(prev => prev.filter(t => t.id !== id));
      },
    });
  }

  async function saveDefaultAgent(provider: string) {
    try {
      await updateDefaultAgentProvider(provider);
      setError('');
    } catch {
      setError('Failed to save default agent');
    }
  }


  async function openClaimLog(box: Instance) {
    try {
      const result = await instancesApi.onClaimLog(box.id);
      setClaimLog({ boxName: box.name, log: result.log || '(empty log)' });
    } catch (err: any) {
      setBoxError(err?.response?.data?.error || 'Could not read the personalization log');
    }
  }

  function renderProjectItem(p: typeof projects[0]) {
    const provider = displayAgentProvider(p);
    const config = provider ? PROVIDERS[provider] : null;
    const mainWs = p.workstreams?.find(ws => ws.name === 'main') ?? p.workstreams?.[0];
    const savedProvider = persistedWorkstreamProvider(p, mainWs?.id);
    const ctxWarn = contextWarning(p);
    const rateLimit = rateLimitWarning(p);
    const stripe = boxStripeColor(p.instanceId);
    const box = p.instanceId ? boxes.find(b => b.id === p.instanceId) : null;
    const parked = isBoxParked(box?.status);
    const wsCount = p.workstreams?.length ?? 0;
    // Only owned projects are pinnable, so only they're selectable in edit mode.
    const selectable = p.role !== 'collaborator';
    const selected = selectMode && selectedIds.has(p.id);
    const unseen = unseenByProject.get(p.id) ?? [];
    const unseenAge = unseen.reduce<UnseenAge | null>((best, u) => (!best || UNSEEN_RANK[u.age] > UNSEEN_RANK[best] ? u.age : best), null);
    return (
      <li
        key={p.id}
        className={`project-item ${unseenAge ? `unseen-${unseenAge}` : ''} ${activeProjectId === p.id ? 'active' : ''} ${selectMode ? 'select-mode' : ''} ${selected ? 'selected' : ''} ${flashingProjects.has(p.id) ? `status-flash-${flashingProjects.get(p.id)}` : ''} ${rateLimit ? 'rate-limited' : ''} ${parked ? 'on-parked-box' : ''}`}
        style={stripe ? ({ ['--box-stripe' as any]: stripe } as React.CSSProperties) : undefined}
        title={box ? `box: ${box.name}${parked ? ` (${box.status})` : ''}` : undefined}
        onClick={() => {
          if (selectMode) {
            if (selectable) toggleSelected(p.id);
          } else {
            setActiveProject(p.id);
          }
        }}
      >
        {selectMode && (
          <input
            type="checkbox"
            className="project-select-checkbox"
            checked={selected}
            disabled={!selectable}
            title={selectable ? undefined : 'Shared projects can’t be pinned'}
            onChange={() => selectable && toggleSelected(p.id)}
            onClick={e => e.stopPropagation()}
          />
        )}
        <span className={`project-status${statusesStale ? ' stale' : ''}`}>
          {parked ? '⏸' : statusGlyph(p)}
          {(() => {
            const { ring, pr, reviewer } = reviewRingFor(p);
            return ring && !parked
              ? <span className={`review-ring is-${ring}`} title={reviewRingTooltip(ring, pr, reviewer)} />
              : null;
          })()}
          {!parked && prPromptPending(p) && (
            <span className="pr-prompt-dot" title="PR opened. Compact or clear the agent's context?" />
          )}
          {parked ? null : rateLimit ? (
            <span className="rate-limit-badge" title={rateLimit} />
          ) : ctxWarn && (
            <span
              className={`ctx-warn ctx-warn-${ctxWarn.level}`}
              title={`Context: ${fmtTokens(ctxWarn.tokens)}. Consider /clear`}
            />
          )}
        </span>
        {renamingId === p.id ? (
          <input
            className="project-rename-input"
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onBlur={() => renameProject(p)}
            onKeyDown={e => {
              if (e.key === 'Enter') renameProject(p);
              if (e.key === 'Escape') cancelRename();
            }}
            onClick={e => e.stopPropagation()}
            autoFocus
          />
        ) : (
          <>
            <span
              className="project-name"
              onDoubleClick={p.role !== 'collaborator' ? (e => {
                e.stopPropagation();
                beginRename(p.id, p.name);
              }) : undefined}
            >
              {p.name}
              {p.role === 'collaborator' && (
                <span className="shared-label" title={`Shared by ${p.ownerUsername}`}>
                  {` (${p.ownerUsername})`}
                </span>
              )}
            </span>
            {unseenAge && (
              <span
                className={`unseen-stop-dot is-${unseenAge}`}
                title={`Stopped since you looked: ${unseen.map(u => `${u.ws} (${formatStopAge(stopClock - u.stoppedAt)} ago)`).join(', ')}`}
              >{unseen.length > 1 ? unseen.length : ''}</span>
            )}
            {wsCount <= 1 && p.role !== 'collaborator' && (
              <WorktreePrPills pills={prPillsFor(p.id, mainWs?.name ?? 'main', statusMap[statusKey(p.instanceId, projectAgentSessions(p)[0])]?.milestone)} />
            )}
            {wsCount > 1 && (
              <span
                className="project-workstream-count"
                title={`${wsCount} workstreams`}
              >↳{wsCount}</span>
            )}
            {config && (
              <span
                className="project-provider-badge"
                style={{
                  borderColor: config.color.bright.replace(/[\d.]+\)$/, '0.45)'),
                  background: config.color.base.replace(/[\d.]+\)$/, '0.16)'),
                }}
                title={`runtime: ${config.displayName}${savedProvider ? `, saved: ${savedProvider}` : ''}${mixedProviderNote(p, provider)}`}
              >
                {config.badge}
              </span>
            )}
          </>
        )}
        {!selectMode && p.kind !== 'metaterm' && (
        <span className="project-actions" onClick={e => e.stopPropagation()}>
          <button
            className="btn-tiny btn-overflow"
            onClick={() => setMenuOpenId(menuOpenId === p.id ? null : p.id)}
          >⋮</button>
          {menuOpenId === p.id && (
            <div className="project-menu" onMouseLeave={() => setMenuOpenId(null)}>
              {p.role === 'collaborator' ? (
                <button onClick={() => { leaveProject(p.id); setMenuOpenId(null); }}>Leave project</button>
              ) : (
                <>
                  <button onClick={() => { togglePin(p); setMenuOpenId(null); }}>
                    {p.pinned ? '◆ Unpin' : '◇ Pin to top'}
                  </button>
                  <button onClick={() => { beginRename(p.id, p.name); setMenuOpenId(null); }}>
                    Rename
                  </button>
                  {(boxSharingOn || sharedProjectIds.has(p.id) || shareProjectId === p.id) && (
                    <button onClick={() => { setShareProjectId(shareProjectId === p.id ? null : p.id); setMenuOpenId(null); }}>
                      {sharedProjectIds.has(p.id) ? '● Sharing' : 'Share'}
                    </button>
                  )}
                  <button onClick={() => {
                    setBranchOffProjectId(branchOffProjectId === p.id ? null : p.id);
                    setNewWorkstreamName('');
                    setMenuOpenId(null);
                  }}>
                    Branch off…
                  </button>
                  {slackCollabOn && (
                    <button onClick={() => {
                      const mainWs = p.workstreams.find(ws => ws.name === 'main') ?? p.workstreams[0];
                      if (mainWs) { setShareError(''); setShareTarget({ project: p, ws: mainWs }); }
                      setMenuOpenId(null);
                    }}>
                      Share to Slack…
                    </button>
                  )}
                  {(() => {
                    // The project row stands for its main workstream's agent.
                    const mainWs = p.workstreams.find(ws => ws.name === 'main') ?? p.workstreams[0];
                    return workstreamHasAgent(p, mainWs) && (
                      <>
                        <button onClick={() => { setSwitchTarget({ project: p, ws: mainWs }); setMenuOpenId(null); }}>
                          Switch agent…
                        </button>
                        {handoffOn && canHandOff(storedWorkstreamProvider(p, mainWs)) && (
                          <button onClick={() => { setHandoffError(''); setHandoffTarget({ project: p, ws: mainWs }); setMenuOpenId(null); }}>
                            Hand off…
                          </button>
                        )}
                      </>
                    );
                  })()}
                  <button className="menu-danger" onClick={() => { archiveProject(p); setMenuOpenId(null); }}>
                    Archive
                  </button>
                </>
              )}
            </div>
          )}
        </span>
        )}
        <CloneProgress
          project={p}
          busy={cloneBusyId === p.id}
          onRetry={() => { void runClone(p, 'retry'); }}
          onStartEmpty={() => { void runClone(p, 'start-empty'); }}
        />
      </li>
    );
  }

  return (
    <div className="project-control">
      {/* Pinned top strip: header, create form, and filter stay visible while
          the sections below scroll inside .project-control-scroll. */}
      <div className="project-control-pinned">
        <div className="project-control-header">
          <div className="project-control-header-row">
            <span className="project-control-title">termag</span>
            <span className="project-control-actions">
              {/* Sign out moved to Settings (rarely used); its slot is the Recents switcher. */}
              <RecentsDropdown />
              {/* The phone client. Opening it here clears a
                  "Full UI" opt-out so the redirect works again on that browser. */}
              <button
                className="btn-ghost"
                onClick={() => { writeOptOut(typeof localStorage !== 'undefined' ? localStorage : null, false); navigate('/m'); }}
                title="Phone view"
                aria-label="Phone view"
              >📱</button>
              {simpleUi && (
                <button className="btn-ghost" onClick={() => navigate('/chat')} title="Simple view" aria-label="Simple view">💬</button>
              )}
              <button className="btn-ghost" onClick={() => navigate('/settings')} title="Settings" aria-label="Settings">⚙</button>
            </span>
          </div>
          {DOCS_SITE_URL && (
            <a
              className="sidebar-docs-link"
              href={DOCS_SITE_URL}
              target="_blank"
              rel="noopener noreferrer"
              title="Docs site"
            >
              How it works ↗
            </a>
          )}
        </div>

        <StatusStrip />

        {error && <div className="error-banner">{error}<button onClick={() => setError('')}>×</button></div>}

        <button
          type="button"
          className="btn-primary new-project-btn"
          onClick={() => { setRepoPromptBoxId(undefined); setShowNewProject(true); }}
        >New project</button>

        {/* Replaces the old project-name Filter…. */}
        <SearchPalette />

        {/* Pinned, not in the scroll below: a stop you haven't looked at must
            not scroll out of sight. The list scrolls
            inside its own few rows instead. */}
        {unseenStops.length > 0 && (
          <section className="control-section unseen-stops-section">
            <div className="control-section-head">
              <h3 title="Stopped since you looked">Unseen stops<span className="unseen-stops-count">{unseenStops.length}</span></h3>
              <button className="btn-ghost btn-select-toggle" onClick={markAllStopsSeen} title="Mark all as seen">Clear</button>
            </div>
            <ul className="unseen-stops-list">
              {unseenStops.map(u => (
                <li
                  key={`${u.project.id}:${u.ws}`}
                  className={`unseen-stop-item unseen-${u.age}`}
                  onClick={() => openWorkstream(u.project.id, u.ws)}
                  title={`${u.project.name}${u.ws !== 'main' ? ` › ${u.ws}` : ''}: stopped ${formatStopAge(stopClock - u.stoppedAt)} ago${u.status === 'not_running' ? ', agent no longer running' : ''}`}
                >
                  <span className="workstream-status"><StatusDot status={u.status} /></span>
                  <span className="unseen-stop-name">
                    {u.project.name}{u.ws !== 'main' && <span className="unseen-stop-ws"> › {u.ws}</span>}
                  </span>
                  <span className="unseen-stop-age">{formatStopAge(stopClock - u.stoppedAt)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

      </div>

      <div className="project-control-scroll">
      {invites.length > 0 && (
        <section className="control-section invite-section">
          <h3>Invites</h3>
          <ul className="invite-list">
            {invites.map(inv => (
              <li key={inv.id} className="invite-item">
                <span className="invite-info">
                  <strong>{inv.projectName}</strong> from {inv.inviterName}
                </span>
                <span className="invite-actions">
                  {boxSharingOn && <button className="btn-tiny btn-success" onClick={() => acceptInvite(inv.id)}>accept</button>}
                  <button className="btn-tiny btn-danger" onClick={() => declineInvite(inv.id)}>decline</button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}


      <section className="control-section">
        <div className="control-section-head">
          <h3>Projects</h3>
          <button
            className="btn-ghost btn-select-toggle"
            onClick={() => { setMenuOpenId(null); selectMode ? exitSelectMode() : setSelectMode(true); }}
          >
            {selectMode ? 'Done' : 'Select'}
          </button>
        </div>
        {selectMode && (() => {
          // Select-all / clear operate on the owned (pinnable) projects — the
          // same set that shows checkboxes. MetaTerm is never one of them: it
          // has no checkbox, and when hidden (Settings → Appearance) "N
          // selected" must not count a row the user cannot see.
          const selectableIds = projects.filter(p => p.role !== 'collaborator' && p.kind !== 'metaterm').map(p => p.id);
          const allSelected = selectableIds.length > 0 && selectableIds.every(id => selectedIds.has(id));
          return (
            <div className="project-select-toolbar">
              <span className="project-select-count">{selectedIds.size} selected</span>
              <button
                className="btn-tiny"
                disabled={selectableIds.length === 0}
                onClick={() => setSelectedIds(allSelected ? new Set() : new Set(selectableIds))}
              >
                {allSelected ? 'Clear' : 'Select all'}
              </button>
              <button className="btn-tiny" disabled={selectedIds.size === 0} onClick={() => bulkSetPinned(true)}>
                ◇ Pin
              </button>
              <button className="btn-tiny" disabled={selectedIds.size === 0} onClick={() => bulkSetPinned(false)}>
                ◆ Unpin
              </button>
            </div>
          );
        })()}
        <ul className="project-list">
          {(() => {
            // Render one project: its row, an optional branch-off form, and any
            // workstream sub-rows. Hoisted so each box group can reuse it.
            // A Claude Code cloud session on a box: no pane to open here, so the
            // row links out to claude.ai; the dot reads the same status map a
            // project pane does, under the runner's tmux name.
            const renderCloudRow = (s: CloudSession) => {
              const dot = cloudDotStatus(s, statusMap);
              const platform = platformLabel(s.clientPlatform);
              // A queued session's age is time queued (the start of its refusals),
              // not time since the latest re-offer; a placed one's is its run's start.
              const ageSince = s.state === 'queued' ? (s.queuedSince ?? s.lastSeenAt) : (s.current?.startedAt ?? s.lastSeenAt);
              const age = fmtAgeShort(Date.now() - Date.parse(ageSince));
              const canEnd = s.state === 'running' || s.state === 'starting';
              // The row shows platform and age; slot and box live in the tooltip.
              const where = s.current ? `slot ${s.current.slot} on ${s.current.boxName}` : null;
              const rowTitle = [cloudLabel(s), s.queuedReason ?? cloudStateLabel(s), where].filter(Boolean).join(' · ');
              const nameNode = <><span className="cloud-session-name">{s.name}</span>{s.title && <span className="cloud-session-subtitle"> {s.title}</span>}</>;
              return (
                <li key={`cloud:${s.key}`} className={`project-item cloud-session-item cloud-${s.state}`} title={rowTitle}>
                  <span className={`project-status${statusesStale ? ' stale' : ''}`}><StatusDot status={dot} /></span>
                  <span
                    className="project-provider-badge cloud-provider-badge"
                    style={{
                      borderColor: PROVIDERS.claude.color.bright.replace(/[\d.]+\)$/, '0.45)'),
                      background: PROVIDERS.claude.color.base.replace(/[\d.]+\)$/, '0.16)'),
                    }}
                    title={s.state === 'queued' ? 'Claude Code cloud session (claude.ai), waiting for a box' : s.state === 'starting' ? 'Claude Code cloud session (claude.ai), starting on this box' : 'Claude Code cloud session (claude.ai), running on this box'}
                  >{PROVIDERS.claude.badge} ☁</span>
                  <span className="cloud-session-main">
                    {cloudRenameKey === s.key ? (
                      <input
                        className="project-rename-input"
                        value={cloudRenameValue}
                        placeholder={`${s.name} title`}
                        onChange={e => setCloudRenameValue(e.target.value)}
                        onBlur={() => { void commitCloudRename(s); }}
                        onKeyDown={e => {
                          if (e.key === 'Enter') void commitCloudRename(s);
                          if (e.key === 'Escape') cancelCloudRename();
                        }}
                        onClick={e => e.stopPropagation()}
                        autoFocus
                      />
                    ) : s.url ? (
                      <a className="project-name cloud-session-title" href={s.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} onDoubleClick={e => { e.preventDefault(); e.stopPropagation(); if (canRenameCloud(s)) beginCloudRename(s); }}>{nameNode}</a>
                    ) : (
                      <span className="project-name cloud-session-title" onDoubleClick={e => { e.stopPropagation(); if (canRenameCloud(s)) beginCloudRename(s); }}>{nameNode}</span>
                    )}
                    {s.state === 'queued'
                      ? <span className="cloud-meta cloud-queued">queued · {age}</span>
                      : <span className="cloud-meta">{[s.state === 'starting' ? 'starting' : null, platform, age].filter(Boolean).join(' · ')}</span>}
                  </span>
                  <span className="project-actions" onClick={e => e.stopPropagation()}>
                    <button className="btn-tiny btn-overflow" onClick={() => setCloudMenuKey(cloudMenuKey === s.key ? null : s.key)}>⋮</button>
                    {cloudMenuKey === s.key && (
                      <div className="project-menu" onMouseLeave={() => setCloudMenuKey(null)}>
                        {s.url && <a className="project-menu-link" href={s.url} target="_blank" rel="noreferrer" onClick={() => setCloudMenuKey(null)}>Open on claude.ai</a>}
                        {canRenameCloud(s)
                          ? <button onClick={() => { beginCloudRename(s); setCloudMenuKey(null); }}>Rename…</button>
                          : <button disabled title="Rename is available after termag places the session on a box">Rename…</button>}
                        {s.current && <button onClick={() => { void showCloudLog(s); setCloudMenuKey(null); }}>Runner log</button>}
                        {canEnd && <button className="menu-danger" onClick={() => { endCloudSession(s); setCloudMenuKey(null); }}>End session</button>}
                      </div>
                    )}
                  </span>
                  {s.state === 'queued' && s.queuedReason && <span className="box-error">{s.queuedReason}</span>}
                </li>
              );
            };

            const renderRow = (p: typeof projects[0]) => {
              const branchingOff = branchOffProjectId === p.id;
              const showWorkstreams = p.workstreams.length > 1;
              const activeWs = getActiveWorkstream(p.id);
              const owner = p.ownerUsername ?? user?.unixUsername ?? '';
              return (
                <React.Fragment key={p.id}>
                  {renderProjectItem(p)}
                  {branchingOff && (
                    <li className="project-workstream-branch-off">
                      <form
                        className="inline-form"
                        onSubmit={e => createWorkstream(e, p.id)}
                        onClick={e => e.stopPropagation()}
                      >
                        <input
                          autoFocus
                          value={newWorkstreamName}
                          onChange={e => setNewWorkstreamName(e.target.value)}
                          placeholder="workstream name (also branch)"
                        />
                        <button type="submit" title="Branch off">+</button>
                        <button
                          type="button"
                          className="btn-tiny"
                          onClick={() => { setBranchOffProjectId(null); setNewWorkstreamName(''); }}
                        >×</button>
                      </form>
                    </li>
                  )}
                  {showWorkstreams && p.workstreams.map(ws => {
                    const wsSession = buildSessionName(owner, p.name, 'agent', ws.name);
                    const wsHasAgent = p.workflows.some(
                      w => w.workstreamId === ws.id && w.type === 'agent',
                    );
                    const wsStatus = statusMap[statusKey(p.instanceId, wsSession)]?.status ?? 'not_running';
                    const wsProvider = wsHasAgent ? workstreamAgentProvider(p, ws) : null;
                    const wsConfig = wsProvider ? PROVIDERS[wsProvider] : null;
                    const wsUnseen = wsHasAgent ? unseenStop(p, ws.name, wsSession) : null;
                    return (
                      <li
                        key={ws.id}
                        className={`project-workstream-item ${wsUnseen ? `unseen-${wsUnseen}` : ''} ${activeProjectId === p.id && activeWs === ws.name ? 'active' : ''}`}
                        onClick={() => openWorkstream(p.id, ws.name)}
                        title={`branch: ${ws.branch}`}
                      >
                        <span className={`workstream-status${statusesStale ? ' stale' : ''}`}>
                          {wsHasAgent ? <StatusDot status={wsStatus} /> : '—'}
                          {(() => {
                            const { ring, pr, reviewer } = reviewRingSession(p.instanceId, wsSession);
                            return wsHasAgent && ring
                              ? <span className={`review-ring is-${ring}`} title={reviewRingTooltip(ring, pr, reviewer)} />
                              : null;
                          })()}
                          {wsHasAgent && prPromptPendingSession(p.instanceId, wsSession) && (
                            <span className="pr-prompt-dot" title="PR opened. Compact or clear this workstream's context?" />
                          )}
                        </span>
                        <span className="workstream-marker">↳</span>
                        {renamingId === ws.id ? (
                          <input
                            className="project-rename-input"
                            value={renameValue}
                            onChange={e => setRenameValue(e.target.value)}
                            onBlur={() => renameWorkstream(p, ws)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') renameWorkstream(p, ws);
                              if (e.key === 'Escape') cancelRename();
                            }}
                            onClick={e => e.stopPropagation()}
                            autoFocus
                          />
                        ) : (
                          <span
                            className="workstream-name"
                            onDoubleClick={ws.name !== 'main' && p.role !== 'collaborator' ? (e => {
                              e.stopPropagation();
                              beginRename(ws.id, ws.name);
                            }) : undefined}
                          >{ws.name}</span>
                        )}
                        {wsUnseen && <span className={`unseen-stop-dot is-${wsUnseen}`} title="Stopped since you looked" />}
                        {p.role !== 'collaborator' && (
                          <WorktreePrPills pills={prPillsFor(p.id, ws.name, statusMap[statusKey(p.instanceId, wsSession)]?.milestone)} />
                        )}
                        {wsConfig && (
                          <span
                            className="project-provider-badge workstream-provider-badge"
                            style={{
                              borderColor: wsConfig.color.bright.replace(/[\d.]+\)$/, '0.45)'),
                              background: wsConfig.color.base.replace(/[\d.]+\)$/, '0.16)'),
                            }}
                            title={`runtime: ${wsConfig.displayName}`}
                          >
                            {wsConfig.badge}
                          </span>
                        )}
                        {ws.name !== 'main' && p.role !== 'collaborator' && (
                          <span className="project-actions" onClick={e => e.stopPropagation()}>
                            <button
                              className="btn-tiny btn-overflow"
                              onClick={() => setMenuOpenId(menuOpenId === ws.id ? null : ws.id)}
                            >⋮</button>
                            {menuOpenId === ws.id && (
                              <div className="project-menu" onMouseLeave={() => setMenuOpenId(null)}>
                                <button onClick={() => { beginRename(ws.id, ws.name); setMenuOpenId(null); }}>
                                  Rename
                                </button>
                                {wsHasAgent && (
                                  <button onClick={() => { setSwitchTarget({ project: p, ws }); setMenuOpenId(null); }}>
                                    Switch agent…
                                  </button>
                                )}
                                {wsHasAgent && handoffOn && p.kind !== 'metaterm' && canHandOff(storedWorkstreamProvider(p, ws)) && (
                                  <button onClick={() => { setHandoffError(''); setHandoffTarget({ project: p, ws }); setMenuOpenId(null); }}>
                                    Hand off…
                                  </button>
                                )}
                                {slackCollabOn && (
                                  <button onClick={() => { setShareError(''); setShareTarget({ project: p, ws }); setMenuOpenId(null); }}>
                                    Share to Slack…
                                  </button>
                                )}
                                <button className="menu-danger" onClick={() => { deleteWorkstream(p, ws); setMenuOpenId(null); }}>
                                  Delete
                                </button>
                              </div>
                            )}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </React.Fragment>
              );
            };

            // Pinned projects float to the top of their own box group.
            const sortPinned = (arr: typeof projects) => [
              ...arr.filter(p => p.pinned),
              ...arr.filter(p => !p.pinned),
            ];

            // Group projects by box: one group per box that has projects (sorted
            // by box name), then collaborator projects on boxes I don't own, then
            // legacy "this host" projects (no instance). Empty groups are hidden.
            // MetaTerm — the per-user control tower — is pinned above every box
            // group. Pull it out so it doesn't also land under "This host".
            // Hidden unless opted in; still shown while it is the open project,
            // so the sidebar never loses the session on screen.
            const metatermProject = projects.find(p => p.kind === 'metaterm');
            const visibility = metatermVisibility({
              optedIn: theme.sidebarMetaTerm,
              metatermId: metatermProject?.id ?? null,
              activeProjectId: activeProjectId ?? null,
            });
            const metaterm = visibility.showRow ? metatermProject : undefined;
            const rest = metatermProject ? projects.filter(p => p.id !== metatermProject.id) : projects;

            const knownBoxIds = new Set(boxes.map(b => b.id));
            const groups: {
              key: string; label: string; color: string | null;
              dot?: string; note?: string | null; rows: typeof projects;
              /** Claude Code cloud sessions running on this box. */
              cloud?: CloudSession[];
            }[] = [];

            [...boxes].sort((a, b) => a.name.localeCompare(b.name)).forEach(b => {
              const rows = sortPinned(rest.filter(p => p.instanceId === b.id));
              const cloudRows = cloud.byBox.get(b.id) ?? [];
              if (!rows.length && !cloudRows.length) return;
              const display = boxDisplay(b.status);
              groups.push({
                key: b.id,
                label: b.name,
                color: boxStripeColor(b.id),
                dot: display.dot,
                note: display.label,
                rows,
                cloud: cloudRows,
              });
            });
            // Runs on a box the list no longer has (terminated under a live
            // runner, before the lost sweep ends it): still shown, as a group
            // of their own, so the header count and the rows agree.
            // Only once the box list has loaded: before that every box is
            // "missing" and live sessions would flash as removed.
            if (boxesLoaded) {
              const elsewhere = cloudElsewhere(cloud.byBox, knownBoxIds);
              if (elsewhere.length) groups.push({ key: '__cloud_elsewhere', label: 'Cloud sessions on removed boxes', color: null, rows: [], cloud: elsewhere });
            }
            // Sessions the orchestrator could not place yet: no box, every slot
            // full, GitHub not connected. The reason is the one the Activity
            // tab shows, so the owner reads the same thing in both places.
            if (cloud.queued.length) {
              groups.push({ key: '__cloud_queued', label: 'Queued cloud sessions', color: null, rows: [], cloud: cloud.queued });
            }

            const shared = sortPinned(rest.filter(p => p.instanceId && !knownBoxIds.has(p.instanceId)));
            if (shared.length) groups.push({ key: '__shared', label: 'Shared with me', color: null, rows: shared });

            const local = sortPinned(rest.filter(p => !p.instanceId));
            if (local.length) groups.push({ key: '__local', label: 'This host', color: null, rows: local });

            if (metaterm) groups.unshift({ key: '__metaterm', label: 'MetaTerm', color: 'var(--accent)', rows: [metaterm] });

            return (
              <>
                {visibility.showEntry && (
                  <li
                    className="project-item project-metaterm-entry"
                    onClick={openMetaTerm}
                    title="Open MetaTerm: a Claude that can read (and, with confirmation, drive) every session you can reach"
                  >
                    <span className="project-name">⚡ MetaTerm</span>
                    <span className="project-group-count">{metatermBusy ? '…' : 'open'}</span>
                  </li>
                )}
                {groups.map(g => (
              <React.Fragment key={g.key}>
                <li
                  className="project-group-header"
                  style={g.color ? ({ ['--box-stripe' as any]: g.color } as React.CSSProperties) : undefined}
                >
                  {g.dot && <span className="project-group-dot" style={{ background: g.dot }} />}
                  <span className="project-group-name" title={g.label}>{g.label}</span>
                  {g.note && <span className="project-group-note">{g.note}</span>}
                  <span className="project-group-count">{g.rows.length + (g.cloud?.length ?? 0)}</span>
                </li>
                {g.rows.map(renderRow)}
                {g.cloud?.map(renderCloudRow)}
              </React.Fragment>
                ))}
              </>
            );
          })()}
        </ul>
        {shareProjectId && (
          <div className="share-panel">
            <h4>Share: {projects.find(p => p.id === shareProjectId)?.name}</h4>
            {boxSharingOn ? (
              <form className="inline-form" onSubmit={sendInvite}>
                <input
                  value={shareEmail}
                  onChange={e => setShareEmail(e.target.value)}
                  placeholder="user email"
                />
                <button type="submit">Invite</button>
              </form>
            ) : (
              <p className="usage-dim">New shares are turned off. Existing ones keep working until revoked.</p>
            )}
            {shares.length > 0 && (
              <ul className="share-list">
                {shares.map(s => (
                  <li key={s.id} className="share-item">
                    <span>{s.userName} ({s.unixUsername})</span>
                    <button className="btn-tiny btn-danger" onClick={() => revokeShare(s.id)}>Revoke</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section className="control-section">
        <h3 className="clickable-header boxes-toggle" onClick={() => setShowBoxes(s => !s)}>
          Boxes {showBoxes ? '▾' : '▸'}
          {boxSummary(boxes, cloudActiveCount) && <span className="boxes-summary">{boxSummary(boxes, cloudActiveCount)}</span>}
        </h3>
        {/* Cloud-session results live outside the expander: the rows that open
            them are in the project list, which stays visible when Boxes is
            collapsed. */}
        {cloudError && <div className="error-banner">{cloudError}<button onClick={() => setCloudError('')}>×</button></div>}
        {cloudLog && (
          <div className="cloud-log">
            <div className="cloud-log-title">{cloudLog.title}<button className="btn-tiny" onClick={() => setCloudLog(null)}>×</button></div>
            <pre className="box-claim-log">{cloudLog.log || '(empty)'}</pre>
          </div>
        )}
        {showBoxes && (
          <div className="boxes-expanded">
            {warmPoolEnabled && warmPool && (
              <div className="box-pool">{warmPool.warm} warm, {warmPool.warming} warming</div>
            )}
            {boxError && <div className="error-banner">{boxError}<button onClick={() => setBoxError('')}>×</button></div>}
            <ul className="box-list">
              {boxes.map(b => {
                const display = boxDisplay(b.status);
                const note = lifecycleNote(b);
                // Same deterministic hue projects use for their "which box" stripe
                // (b.id is the project's instanceId), so this box is color-matched
                // to the project rows running on it.
                const stripe = boxStripeColor(b.id);
                return (
                  <li
                    key={b.id}
                    className="box-item"
                    style={stripe ? ({ ['--box-stripe' as any]: stripe } as React.CSSProperties) : undefined}
                  >
                    <span
                      className={`box-status-dot ${display.spinning ? 'box-spinning' : ''}`}
                      style={{ background: display.dot }}
                      title={(b.status === 'failed' || showsBoxError(b)) && b.provisioningError ? b.provisioningError : b.status}
                    />
                    <span className="box-name" title={boxNameTitle(b.hostname, b.imageId)}>{b.name}</span>
                    {(b.onClaimStatus === 'pending' || b.onClaimStatus === 'running') && (
                      <button type="button" className="box-claim-badge" title="Applying dotfiles">personalizing</button>
                    )}
                    {b.onClaimStatus === 'failed' && (
                      <button type="button" className="box-claim-badge box-claim-badge-failed" title={b.onClaimError ?? 'personalization failed'} onClick={() => openClaimLog(b)}>failed</button>
                    )}
                    {b.onClaimStatus === 'skipped' && b.onClaimError && (
                      <button type="button" className="box-claim-badge" title={b.onClaimError} onClick={() => openClaimLog(b)}>dotfiles later</button>
                    )}
                    {b.kind === 'external' && <span className="box-kind-badge" title="self-managed host">self</span>}
                    {(() => {
                      const image = boxImageBadge(b.imageId, b.imageSource);
                      return image && <span className={`box-kind-badge${image.fallback ? ' box-image-fallback' : ''}`} title={image.title}>{image.label}</span>;
                    })()}
                    <span className="box-meta">
                      {display.label ?? `${b._count?.projects ?? 0} proj${cloud.byBox.get(b.id)?.length ? ` · ${cloudCountLabel(cloud.byBox.get(b.id)!.length)}` : ''}`}
                    </span>
                    <span className="project-actions" onClick={e => e.stopPropagation()}>
                      <button
                        className="btn-tiny btn-overflow"
                        onClick={() => setBoxMenuOpenId(boxMenuOpenId === b.id ? null : b.id)}
                      >⋮</button>
                      {boxMenuOpenId === b.id && (
                        <div className="project-menu" onMouseLeave={() => setBoxMenuOpenId(null)}>
                          {canStartBox(b) && (
                            <button onClick={() => { startBox(b); setBoxMenuOpenId(null); }}>
                              {b.status === 'hibernated' ? 'Resume box' : 'Start box'}
                            </button>
                          )}
                          {canHibernateBox(b) && (
                            <button
                              title="Save memory to disk and power off; start resumes where you left off"
                              onClick={() => { hibernateBox(b); setBoxMenuOpenId(null); }}
                            >Hibernate box</button>
                          )}
                          {canStopBox(b) && (
                            <button onClick={() => { stopBox(b); setBoxMenuOpenId(null); }}>Stop box</button>
                          )}
                          {offersAutoHibernate(b, autoLifecycleOn) && (
                            <button
                              title="Hibernate this box on its own after it has been idle for a while"
                              onClick={() => { setLifecycleBox(b); setBoxMenuOpenId(null); }}
                            >Auto-park…</button>
                          )}
                          {spacesOn && b.status !== 'terminated' && (
                            <button
                              title="Choose which spaces this box can reach"
                              onClick={() => { setBoxSpaces(b); setBoxMenuOpenId(null); }}
                            >Spaces…</button>
                          )}
                          <button className="menu-danger" onClick={() => { terminateBox(b); setBoxMenuOpenId(null); }}>
                            Terminate
                          </button>
                        </div>
                      )}
                    </span>
                    {repoPickerOn && repoPromptDue({
                      kind: b.kind,
                      dismissedAt: b.repoPromptDismissedAt ?? null,
                      liveCount: projects.filter(p => !p.archived && p.instanceId === b.id).length,
                    }) && (
                      <div className="box-repo-prompt">
                        Which repository is this box for?
                        <button type="button" className="btn-tiny" onClick={() => { setRepoPromptBoxId(b.id); setShowNewProject(true); }}>Pick a repository…</button>
                        <button type="button" className="btn-tiny" onClick={() => void dismissRepoPrompt(b)}>None</button>
                      </div>
                    )}
                    {showsBoxError(b) && <span className="box-error">{b.provisioningError}</span>}
                    {hibernationAgeNote(b) && <span className="box-error">{hibernationAgeNote(b)}</span>}
                    {note && <span className="box-error box-note" title={note.title}>{note.text}</span>}
                    {b.rehibernatePending && b.status !== 'hibernated' && (
                      <span className="box-error">Resumed to restart the 60-day hibernation limit; hibernates again once ready.</span>
                    )}
                  </li>
                );
              })}
              {boxes.length === 0 && <li className="box-empty">No boxes yet</li>}
              {autoTerminated.map(t => (
                <li key={t.id} className="box-auto-terminated" title={new Date(t.autoTerminatedAt).toLocaleString()}>
                  {autoTerminatedText(t)}
                </li>
              ))}
            </ul>
            {claimLog && (
              <pre className="box-claim-log" title={claimLog.boxName}>{claimLog.log}</pre>
            )}

            {createdBox && (
              <div className={`token-created ${REPLAY_BLOCK_CLASS}`}>
                <div className="token-created-label">
                  Self-managed box “{createdBox.name}”: add this to <code>agent.config.json</code> on that
                  machine and start the termag agent (copy it now; termag shows it only once):
                </div>
                <code className="token-value">{JSON.stringify(
                  { termag_url: createdBox.agentWsUrl ?? 'wss://<your-orchestrator>/termag/ws/agent', token: createdBox.token },
                  null, 2,
                )}</code>
                <button className="btn-tiny" onClick={() => {
                  navigator.clipboard.writeText(JSON.stringify(
                    { termag_url: createdBox.agentWsUrl ?? 'wss://<your-orchestrator>/termag/ws/agent', token: createdBox.token },
                    null, 2,
                  ));
                  setCreatedBox(null);
                }}>Copy &amp; dismiss</button>
              </div>
            )}
            {/* EC2 boxes are created from New project (which waits for them);
                this registers a machine the user runs the agent on themselves. */}
            <form className="inline-form box-create-form" onSubmit={registerSelfManagedBox}>
              <input
                value={newBoxName}
                onChange={e => {
                  setNewBoxName(e.target.value);
                  const name = e.target.value.trim();
                  setBoxError(name && !isValidBoxName(name) ? BOX_NAME_ERROR : '');
                }}
                placeholder="self-managed machine"
                title={BOX_NAME_ERROR}
              />
              <button type="submit" title="Register a self-managed box (run the agent on your own machine)">+</button>
            </form>
          </div>
        )}
      </section>

      {spacesOn && (
        <section className="control-section spaces-section">
          <h3 className="clickable-header" onClick={() => setShowSpaces(s => !s)}>
            Spaces {showSpaces ? '▾' : '▸'}
            {spaces.length > 0 && <span className="boxes-summary">{spaces.length}</span>}
          </h3>
          {showSpaces && (
            <div className="boxes-expanded">
              {spacesError && <div className="error-banner">{spacesError}<button onClick={() => setSpacesError('')}>×</button></div>}
              <ul className="box-list">
                {spaces.map(sp => (
                  <li key={sp.id} className="box-item space-item" onClick={() => setOpenSpace(sp)} title={sp.description ?? undefined}>
                    <span className="box-name">{sp.name}</span>
                    <span className="box-meta">{sp.role}{sp.readOnly ? ' · read-only' : ''} · {formatSpaceBytes(sp.usedBytes)}</span>
                  </li>
                ))}
                {spaces.length === 0 && <li className="box-empty">No spaces yet: shared folders your boxes can reach</li>}
              </ul>
              <form className="inline-form box-create-form" onSubmit={createSpace}>
                <input
                  value={newSpaceName}
                  onChange={e => setNewSpaceName(e.target.value)}
                  placeholder="new space"
                  aria-label="New space name"
                  title={SPACE_NAME_HINT}
                />
                <button type="submit" title="Create a space; you become its owner">+</button>
              </form>
            </div>
          )}
        </section>
      )}

      <section className="control-section">
        <h3 className="clickable-header" onClick={() => setShowTokens(s => !s)}>
          Agent {showTokens ? '▾' : '▸'}
        </h3>
        {showTokens && (
          <>
            {createdToken && (
              <div className={`token-created ${REPLAY_BLOCK_CLASS}`}>
                <div className="token-created-label">New token (copy it now; termag shows it only once):</div>
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
                value={storedDefault}
                onChange={e => saveDefaultAgent(e.target.value)}
              >
                {legacyDefault && (
                  <option value={legacyDefault} disabled>{PROVIDERS[legacyDefault].displayName} (current, no longer offered)</option>
                )}
                {SELECTABLE_PROVIDER_IDS.map(pid => (
                  <option key={pid} value={pid}>{PROVIDERS[pid].displayName}</option>
                ))}
              </select>
            </div>
          </>
        )}
      </section>
      </div>
      {showNewProject && (
        <NewProjectDialog
          initialBoxId={repoPromptBoxId}
          onClose={() => setShowNewProject(false)}
          onBranchOff={projectId => {
            setShowNewProject(false);
            setBranchOffProjectId(projectId);
          }}
        />
      )}
      {lifecycleBox && createPortal(
        <BoxLifecycleDialog box={lifecycleBox} onClose={() => setLifecycleBox(null)} onSaved={() => { void reloadBoxes(); }} />,
        document.body,
      )}
      {openSpace && createPortal(
        <SpaceDialog
          space={openSpace}
          myBoxes={boxes}
          userId={user?.id}
          onClose={() => setOpenSpace(null)}
          onChanged={() => { void reloadSpaces(); }}
        />,
        document.body,
      )}
      {boxSpaces && createPortal(
        <BoxSpacesDialog
          box={boxSpaces}
          onClose={() => setBoxSpaces(null)}
          onOpenSpaces={() => { setBoxSpaces(null); setShowSpaces(true); }}
        />,
        document.body,
      )}
      {shareTarget && createPortal(
        <ShareToSlackDialog
          title={shareTarget.ws.name === 'main' ? shareTarget.project.name : `${shareTarget.project.name} / ${shareTarget.ws.name}`}
          busy={shareBusy}
          error={shareError}
          sent={shareSent}
          onSend={shareToSlack}
          onCancel={() => { if (!shareBusy) { setShareTarget(null); setShareSent(null); } }}
        />,
        document.body,
      )}
      {switchTarget && createPortal(
        <SwitchAgentDialog
          title={switchTarget.ws.name === 'main' ? switchTarget.project.name : `${switchTarget.project.name} / ${switchTarget.ws.name}`}
          current={storedWorkstreamProvider(switchTarget.project, switchTarget.ws)}
          busy={switchBusy}
          onSwitch={switchAgent}
          onCancel={() => { if (!switchBusy) setSwitchTarget(null); }}
        />,
        document.body,
      )}
      {handoffTarget && createPortal(
        <HandoffDialog
          title={handoffTarget.ws.name === 'main' ? handoffTarget.project.name : `${handoffTarget.project.name} / ${handoffTarget.ws.name}`}
          current={storedWorkstreamProvider(handoffTarget.project, handoffTarget.ws)}
          busy={handoffBusy}
          error={handoffError}
          onStart={startHandoff}
          onCancel={() => { if (!handoffBusy) setHandoffTarget(null); }}
        />,
        document.body,
      )}
      {confirmState && createPortal(
        <ConfirmDialog
          message={confirmState.message}
          confirmLabel={confirmState.confirmLabel}
          tone={confirmState.tone}
          onConfirm={() => { setConfirmState(null); confirmState.onConfirm(); }}
          onCancel={() => setConfirmState(null)}
        />,
        document.body,
      )}
    </div>
  );
}
