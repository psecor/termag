// The phone client: an attention-sorted session list, a
// search tab, a chat
// view over the agent pane, and the PR pipeline. Mounted at /m/* inside the same providers as the
// workspace (auth, flags, connection, projects) but without
// MainLayout — no terminals, no starfield.
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { ConnectionOverlay } from '../../components/ConnectionOverlay';
import { FLAGS, useFlag } from '../../flags';
import { useProjects } from '../../contexts/ProjectContext';
import { checkTappedNotification, dropBlockedSubscription, NAVIGATE_EVENT, registerServiceWorker, routerPathFor, syncAttention } from '../../mobile/push';
import { isStandalone, setInstalledAppEnabled } from '../../mobile/redirect';
import { infersTaps, notificationKey } from '../../mobile/shownNotifications';
import type { StatusMap } from '../../types';
import { useHome } from '../../mobile/useHome';
import { useVisualViewport } from '../../mobile/useVisualViewport';
import { Inbox } from './Inbox';
import { Conversation } from './Conversation';
import { NewProject } from './NewProject';
import { NewAutomation } from './NewAutomation';
import { Prs } from './Prs';
import { Search } from './Search';
import { Share } from './Share';
import './mobile.css';

/**
 * Keep the home-screen badge and the shown notifications in step with what is
 * waiting: on every status change, and when the app comes
 * back to the front — the worker cannot quietly close a notification on iOS.
 */
function useAttentionSync() {
  const { statusMap } = useProjects();
  const { counts } = useHome();
  // Sessions whose status has arrived and is not waiting; one not heard from
  // yet is not resolved (statuses stream in after the page opens).
  const resolved = useMemo(
    () => new Set(Object.entries(statusMap).filter(([, s]) => s && s.status !== 'waiting').map(([k]) => k)),
    [statusMap],
  );
  const latest = useRef({ resolved, attention: counts.attention });
  latest.current = { resolved, attention: counts.attention };
  useEffect(() => { void syncAttention(resolved, counts.attention); }, [resolved, counts.attention]);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void syncAttention(latest.current.resolved, latest.current.attention);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
}

/**
 * Pinch-zoom back on under /m. index.html locks zoom for
 * the workspace, whose terminals and chrome block touch zoom on purpose
 * (App.css); the phone client's inputs are 16 px, so iOS will not zoom on
 * focus, and a locked viewport keeps Android readers from zooming text.
 */
function useZoomableViewport() {
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta) return;
    const original = meta.content;
    meta.content = original
      .split(',')
      .map(p => p.trim())
      .filter(p => !/^(maximum-scale|user-scalable)=/.test(p))
      .join(', ');
    return () => { meta.content = original; };
  }, []);
}

/** A notification click routes here in place (main.tsx raises the event). */
function useNotificationNavigation() {
  const navigate = useNavigate();
  useEffect(() => {
    const onNavigate = (e: Event) => {
      const path = routerPathFor((e as CustomEvent<URL>).detail);
      if (!path) return;
      e.preventDefault();
      navigate(path);
    };
    window.addEventListener(NAVIGATE_EVENT, onNavigate);
    return () => window.removeEventListener(NAVIGATE_EVENT, onNavigate);
  }, [navigate]);
}

/** How long an inferred tap waits for its session's status to say waiting. */
const INFERRED_TAP_MS = 15_000;

/**
 * A notification tapped while the installed app was alive, on Apple's WebKit,
 * where no click event arrives (shownNotifications.ts): look when the page
 * loads or comes to the front, and open what was tapped. Only while its
 * session is still waiting: a notification iOS recorded but never displayed
 * also looks vanished, and opening a session with nothing to answer is the
 * worse mistake. Going to the background only forgets what vanished meanwhile,
 * so a notification that went while the app was in front opens nothing later.
 */
function useInferredNotificationTap() {
  const navigate = useNavigate();
  const { statusMap } = useProjects();
  const latestStatus = useRef(statusMap);
  latestStatus.current = statusMap;
  const pending = useRef<{ key: string; path: string; until: number } | null>(null);

  const openIfWaiting = useCallback((map: StatusMap) => {
    const p = pending.current;
    if (!p) return;
    if (Date.now() > p.until) { pending.current = null; return; }
    if (map[p.key]?.status !== 'waiting') return;
    pending.current = null;
    const here = `${window.location.pathname.slice('/termag'.length)}${window.location.search}`;
    if (p.path !== here) navigate(p.path);
  }, [navigate]);

  useEffect(() => { openIfWaiting(statusMap); }, [statusMap, openIfWaiting]);

  useEffect(() => {
    if (!infersTaps({ vendor: navigator.vendor ?? '', standalone: isStandalone(window) })) return;
    const look = (open: boolean) => {
      void checkTappedNotification(open).then(hit => {
        const path = hit ? routerPathFor(new URL(hit.url)) : null;
        if (!hit || !path) return;
        pending.current = { key: notificationKey(hit.tag), path, until: Date.now() + INFERRED_TAP_MS };
        openIfWaiting(latestStatus.current);
      });
    };
    look(true);
    const onVisibility = () => look(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [openIfWaiting]);
}

export default function MobileApp() {
  const root = useRef<HTMLDivElement>(null);
  // The opt-out helpers read it (mobile/redirect.ts); /m can be the first page loaded.
  setInstalledAppEnabled(useFlag(FLAGS.mobileInstalledApp, false));
  useNotificationNavigation();
  useInferredNotificationTap();
  useZoomableViewport();
  useVisualViewport(root);
  useAttentionSync();
  // No fetch handler (public/sw.js), so registering on every visit is harmless
  // and keeps notification clicks and getNotifications() working. Each visit
  // also drops a subscription whose notifications were blocked meanwhile.
  useEffect(() => {
    void registerServiceWorker().then(() => dropBlockedSubscription());
    const onVisible = () => { if (document.visibilityState === 'visible') void dropBlockedSubscription(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
  return (
    <div className="m-root" ref={root}>
      <ConnectionOverlay />
      <Routes>
        <Route index element={<Inbox />} />
        <Route path="p/:projectId" element={<Conversation />} />
        <Route path="search" element={<Search />} />
        <Route path="new" element={<NewProject />} />
        <Route path="new-automation" element={<NewAutomation />} />
        <Route path="prs" element={<Prs />} />
        <Route path="share" element={<Share />} />
        <Route path="*" element={<Navigate to="/m" replace />} />
      </Routes>
    </div>
  );
}
