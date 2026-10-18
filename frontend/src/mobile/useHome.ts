// The home list's rows and counts from ProjectContext state (no fetch of its
// own), plus a 30 s clock for the row ages. Shared by the Sessions and Search
// tabs so the tab bar's count and the rows agree.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useProjects } from '../contexts/ProjectContext';
import { cloudSessionFeed } from '../services/cloudSessionFeed';
import { FLAGS, useFlag } from '../flags';
import { buildHome, Home } from './inbox';

export function useHome(): Home & { now: number } {
  const { user } = useAuth();
  const { projects, statusMap } = useProjects();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  // Cloud sessions ride along behind the flag; App starts the feed.
  const cloudOn = useFlag(FLAGS.cloudSessions, false);
  const cloudAll = useSyncExternalStore(cloudSessionFeed.subscribe, cloudSessionFeed.getSnapshot);
  const cloudSessions = cloudOn ? cloudAll : null;
  const home = useMemo(
    () => buildHome(projects, statusMap, user?.unixUsername ?? '', { cloudSessions }),
    [projects, statusMap, user?.unixUsername, cloudSessions],
  );
  return { ...home, now };
}
