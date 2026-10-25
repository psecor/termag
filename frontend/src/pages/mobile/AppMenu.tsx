// The home screen's ⋯ menu: notifications (when push
// is available to this user), install, reload (a standalone window has no
// browser reload), and Full UI.
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { optOutOfMobile } from '../../mobile/redirect';
import { currentInstallOption, promptInstall, subscribeInstall } from '../../mobile/install';
import { reloadApp } from '../../mobile/useMobileRefresh';
import { pushApi } from '../../services/api';
import { ActionSheet, Sheet, SheetAction } from './Sheet';
import { NotificationsSheet } from './NotificationsSheet';

type Open = null | 'menu' | 'notifications' | 'install-ios';

export function AppMenu() {
  const navigate = useNavigate();
  const [open, setOpen] = useState<Open>(null);
  const install = useSyncExternalStore(subscribeInstall, currentInstallOption, () => 'none' as const);
  // Off without VAPID keys or with mobile-web-push-enabled off for this user (routes/push.ts).
  const [pushAvailable, setPushAvailable] = useState(false);
  useEffect(() => {
    let live = true;
    pushApi.config().then(c => { if (live) setPushAvailable(c.enabled); }).catch(() => {});
    return () => { live = false; };
  }, []);

  const actions: SheetAction[] = [];
  if (pushAvailable) actions.push({ label: 'Notifications…', onClick: () => setOpen('notifications') });
  if (install === 'prompt') actions.push({ label: 'Install app', onClick: () => { void promptInstall(); } });
  if (install === 'ios-instructions') actions.push({ label: 'Add to Home Screen…', onClick: () => setOpen('install-ios') });
  actions.push(
    { label: 'Reload app', onClick: reloadApp },
    { label: 'Full UI', onClick: () => { optOutOfMobile(); navigate('/'); } },
  );

  return (
    <>
      <button className="m-link m-more" onClick={() => setOpen('menu')} aria-label="More" title="More">⋯</button>
      {open === 'menu' && <ActionSheet actions={actions} onClose={() => setOpen(null)} />}
      {open === 'notifications' && <NotificationsSheet onClose={() => setOpen(null)} onInstall={() => setOpen('install-ios')} />}
      {open === 'install-ios' && <InstallIosSheet pushAvailable={pushAvailable} onClose={() => setOpen(null)} />}
    </>
  );
}

export function InstallIosSheet({ pushAvailable, onClose }: { pushAvailable: boolean; onClose: () => void }) {
  return (
    <Sheet title="Add termag to your Home Screen" onClose={onClose}>
      <ol className="m-sheet-steps">
        {/* iOS 26+ moved Share into the address bar's page menu and Add to Home
            Screen behind View More (iOS 27 simulator, 2026-10-14); older iOS has
            Share in the toolbar. */}
        <li>Tap <strong>Share</strong> <span aria-hidden>(the square with an arrow)</span>. Not in Safari's toolbar? Tap <strong>≡</strong> in the address bar, then <strong>Share</strong>.</li>
        <li>Choose <strong>Add to Home Screen</strong> (under <strong>View More</strong> if it isn't listed). Leave <strong>Open as Web App</strong> on, then tap <strong>Add</strong>.</li>
        <li>Open termag from its new icon.</li>
      </ol>
      {pushAvailable && (
        <div className="m-sheet-message m-form-note">
          On iPhone and iPad, notifications only work in the app opened from the Home Screen, not in a Safari tab.
        </div>
      )}
      <div className="m-sheet-actions">
        <button className="m-sheet-action m-sheet-cancel" onClick={onClose}>Done</button>
      </div>
    </Sheet>
  );
}
