// A notification tapped while the installed app was alive, on Apple's WebKit,
// which sends no notificationclick for a live Home Screen app
// (shownNotifications.ts). Used by the phone client, and
// by the chat under chat-phone-home-enabled (phoneNotifications.tsx).
import { useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProjects } from '../contexts/ProjectContext';
import type { StatusMap } from '../types';
import { checkTappedNotification, routerPathFor } from './push';
import { isStandalone } from './redirect';
import { infersTaps, notificationKey } from './shownNotifications';

/** How long an inferred tap waits for its session's status to say waiting. */
const INFERRED_TAP_MS = 15_000;

/**
 * Look when the page loads or comes to the front, and open what was tapped.
 * Only while its session is still waiting: a notification iOS recorded but
 * never displayed also looks vanished, and opening a session with nothing to
 * answer is the worse mistake. Going to the background only forgets what
 * vanished meanwhile, so a notification that went while the app was in front
 * opens nothing later.
 */
export function useInferredNotificationTap(): void {
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
