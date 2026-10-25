import React, { useEffect, useState } from 'react';
import { previewSharesApi, type SharedWithMe } from '../../services/api';

// How often an open dashboard asks again: a share made, revoked or ended meanwhile shows within this.
const REFRESH_MS = 60_000;

/**
 * "Previews shared with you" on the dashboard: the
 * live preview shares someone made for you, each a link to its guest page.
 * Nothing shows when there are none. The dashboard has no flag provider, so
 * the server decides: it lists only what is live and shared with you. Asked
 * again every minute and when the tab comes back; one that expired since is
 * dropped at once.
 */
export function SharedPreviewsSection({ now }: { now: number }) {
  const [shares, setShares] = useState<SharedWithMe[] | null>(null);
  useEffect(() => {
    let gone = false;
    const load = () => {
      previewSharesApi.sharedWithMe().then(s => { if (!gone) setShares(s); }, () => { if (!gone) setShares(prev => prev ?? []); });
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { gone = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  const live = (shares ?? []).filter(s => Date.parse(s.expiresAt) > now);
  if (live.length === 0) return null;
  return (
    <section className="dash-section" aria-labelledby="shared-previews-h">
      <div className="dash-section-title" id="shared-previews-h">
        <span>Previews shared with you</span>
        <span className="usage-dim">{live.length}</span>
      </div>
      <ul className="shared-previews">
        {live.map(s => {
          const hours = Math.max(0, Math.round((Date.parse(s.expiresAt) - now) / 3_600_000));
          return (
            <li key={s.id}>
              <a href={`/termag/preview/${s.id}`}>{s.owner.name}'s {s.project.name}</a>
              <span className="usage-dim"> · {s.pr ? `${s.pr.repo.split('/')[1]}#${s.pr.number}` : s.workstream} · {hours >= 48 ? `${Math.round(hours / 24)} days left` : `${hours} h left`}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
