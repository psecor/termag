// The phone client's side of its notifications. /m runs
// these hooks always. Under chat-phone-home-enabled, where phones land in the
// chat instead, the chat renders PhoneNotificationUpkeep on a phone and
// InferredNotificationTap wherever the flag is on (a Mac's installed Safari
// app gets no notificationclick either, and its needs-you taps open the chat).
import { useEffect, useMemo, useRef } from 'react';
import { useProjects } from '../contexts/ProjectContext';
import { dropBlockedSubscription, registerServiceWorker, syncAttention } from './push';
import { useHome } from './useHome';
import { useInferredNotificationTap } from './useInferredNotificationTap';

/**
 * Keep the home-screen badge and the shown notifications in step with what is
 * waiting: on every status change, and when the app comes back to the front.
 * The worker cannot quietly close a notification on iOS.
 */
export function useAttentionSync(): void {
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
 * No fetch handler (public/sw.js), so registering on every visit is harmless
 * and keeps notification clicks and getNotifications() working. Each visit
 * also drops a subscription whose notifications were blocked meanwhile, so
 * the server stops counting it (and pushMutesChat stops muting Slack for it).
 */
export function useServiceWorkerUpkeep(): void {
  useEffect(() => {
    void registerServiceWorker().then(() => dropBlockedSubscription());
    const onVisible = () => { if (document.visibilityState === 'visible') void dropBlockedSubscription(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
}

/** The badge, clearing and the worker's upkeep, for a page that is the phone client. */
export function PhoneNotificationUpkeep(): null {
  useAttentionSync();
  useServiceWorkerUpkeep();
  return null;
}

/** useInferredNotificationTap as a component, so a page can mount it only when it wants it. */
export function InferredNotificationTap(): null {
  useInferredNotificationTap();
  return null;
}
