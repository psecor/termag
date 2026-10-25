// The browser half of "your turn" notifications:
// the open tab's notifier and the state behind Settings → Notifications.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useProjects } from '../contexts/ProjectContext';
import { FLAGS, useFlag } from '../flags';
import { pushApi } from '../services/api';
import { buildRows } from '../mobile/inbox';
import { pushEndpointRemembered, registerServiceWorker, SW_SCOPE } from '../mobile/push';
import { chatEvents } from './chatEvents';
import { chatTurnTag, chatTurnUrl, seedWorkingTurns, shouldNotifyHere, stepTurn, turnNotificationText, turnPreview } from './turnNotify';

export function currentPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

let pushConfigEnabled: Promise<boolean> | null = null;

/** Whether the server would push to this person (VAPID keys and mobile-web-push-enabled), asked once per page. */
export function pushConfigured(): Promise<boolean> {
  pushConfigEnabled ??= pushApi.config().then(c => !!c.enabled && !!c.publicKey).catch(() => false);
  return pushConfigEnabled;
}

/** pushConfigured() as state, false until it answers. */
export function usePushAvailable(active: boolean): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!active) return;
    let live = true;
    void pushConfigured().then(v => { if (live) setAvailable(v); });
    return () => { live = false; };
  }, [active]);
  return available;
}

/** This device gets the chat's push itself: the server pushes to this person and the device registered. */
export function pushCoversDevice(pushAvailable: boolean): boolean {
  return pushAvailable && pushEndpointRemembered();
}

/** Whether this person gets "your turn" notifications: the flag and their opt-in. */
export function useChatTurnEnabled(): { flag: boolean; enabled: boolean } {
  const flag = useFlag(FLAGS.chatTurnNotifications, false);
  const { user } = useAuth();
  return { flag, enabled: flag && !!user?.chatTurnNotify };
}

async function showTurnNotification(title: string, body: string, tag: string, url: string): Promise<void> {
  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration(SW_SCOPE).catch(() => undefined) : undefined;
  const options = { body, tag, icon: '/termag/icons/icon-192.png', badge: '/termag/icons/icon-monochrome-96.png', data: { url } };
  // Through the worker when there is one: the same tag as a push replaces it,
  // and a click arrives as notificationclick (public/sw.js).
  if (reg) { await reg.showNotification(title, options); return; }
  const n = new Notification(title, options);
  n.onclick = () => {
    n.close();
    window.focus();
    window.location.assign(url);
  };
}

/**
 * Mounted once by the simple UI: shows a notification when a chat this
 * person can see ends its turn, unless push brings it to this device or
 * they are looking at that chat. The status socket only carries chats the
 * person may see (services/chatRunner.ts mayReceiveChat).
 */
export function useChatTurnNotifier(shown: { projectId: string; workstream: string } | null): void {
  const { enabled } = useChatTurnEnabled();
  const { user } = useAuth();
  const { projects, statusMap } = useProjects();
  const latest = useRef({ shown, projects });
  latest.current = { shown, projects };
  // Per chat: in a turn this page should hear the end of.
  const open = useRef(new Map<string, boolean>());
  // From the page's status map: a chat already working when the page loaded
  // still notifies on its answer.
  const working = useMemo(
    () => buildRows(projects, statusMap, user?.unixUsername ?? '').filter(r => r.status === 'working').map(r => r.key),
    [projects, statusMap, user?.unixUsername],
  );
  useEffect(() => { seedWorkingTurns(open.current, working); }, [working]);

  useEffect(() => {
    if (!enabled) return;
    // A worker lets a click route the open window (ChatApp) instead of reloading it.
    void registerServiceWorker();
    return chatEvents.subscribe(frame => {
      const key = `${frame.projectId}|${frame.workstream}`;
      const step = stepTurn(open.current.get(key) ?? false, frame.event);
      open.current.set(key, step.open);
      if (!step.ready) return;
      const preview = turnPreview(frame.event);
      // Wait for the push config rather than read it as false: a device push
      // covers would otherwise get this notification and the push too.
      void pushConfigured().then(push => {
        const { shown: on, projects: list } = latest.current;
        const chat = { projectId: frame.projectId, workstream: frame.workstream };
        if (!shouldNotifyHere({
          enabled: true,
          permission: currentPermission(),
          pushCovers: pushCoversDevice(push),
          looking: document.visibilityState === 'visible' && document.hasFocus(),
          shown: on,
          chat,
        })) return;
        const name = list.find(p => p.id === frame.projectId)?.name ?? 'termag';
        const { title, body } = turnNotificationText(name, frame.workstream, preview);
        return showTurnNotification(title, body, chatTurnTag(chat.projectId, chat.workstream), chatTurnUrl(chat.projectId, chat.workstream));
      }).catch(err => console.warn('[chat] notification failed:', err));
    });
  }, [enabled]);
}
