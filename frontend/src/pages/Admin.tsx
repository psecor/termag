import React, { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import type { AdminRange } from '../services/adminApi';
import { RangePicker } from './dashboard/RangePicker';
import { AdminOverview } from './admin/AdminOverview';
import { AdminFleet } from './admin/AdminFleet';
import { AdminSegments } from './admin/AdminSegments';
import { AdminUsers } from './admin/AdminUsers';
import { AdminProjects } from './admin/AdminProjects';
import { AdminUsage } from './admin/AdminUsage';
import { AdminSystem } from './admin/AdminSystem';
import { AdminCloud } from './admin/AdminCloud';
import { AdminSettings } from './admin/AdminSettings';
import { AdminSoftware } from './admin/AdminSoftware';
import { AdminPrs } from './admin/AdminPrs';

const RANGE_KEY = 'termag:adminRange';
// Absolute paths: a relative `to=""` resolves to the current URL inside the
// nested <Routes>, so Overview would never navigate back from another tab.
const TABS = [
  { to: '/admin', label: 'Overview', end: true },
  { to: '/admin/fleet', label: 'Fleet' },
  { to: '/admin/users', label: 'Users' },
  { to: '/admin/segments', label: 'Segments' },
  { to: '/admin/projects', label: 'Projects & sessions' },
  { to: '/admin/usage', label: 'Usage' },
  { to: '/admin/cloud', label: 'Cloud sessions' },
  { to: '/admin/prs', label: 'PRs' },
  { to: '/admin/software', label: 'Software' },
  { to: '/admin/system', label: 'System' },
  { to: '/admin/settings', label: 'Settings' },
];

export function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), everyMs); return () => clearInterval(t); }, [everyMs]);
  return now;
}

/**
 * Orchestrator-wide admin view. Same mounting rules
 * as the Dashboard: own route, no ProjectProvider / MainLayout, no heartbeat.
 * The server enforces admin on every call; this component only hides itself.
 */
export default function Admin() {
  const { user } = useAuth();
  const [range, setRange] = useState<AdminRange>(() => (localStorage.getItem(RANGE_KEY) as AdminRange) || '7d');
  useEffect(() => { localStorage.setItem(RANGE_KEY, range); }, [range]);
  const now = useNow(15_000);

  if (user && user.role !== 'admin') return <Navigate to="/dashboard" replace />;

  return (
    <div className="dash-root">
      <div className="dash-page admin-page">
        <header className="dash-header">
          <h1>Admin</h1>
          <Link to="/dashboard">← dashboard</Link>
          <Link to="/">workspace</Link>
          <nav className="admin-tabs" aria-label="admin sections">
            {TABS.map(t => <NavLink key={t.to} to={t.to} end={t.end}>{t.label}</NavLink>)}
          </nav>
        </header>
        <Routes>
          <Route index element={<><RangePicker value={range} onChange={setRange} /><AdminOverview range={range} now={now} /></>} />
          <Route path="fleet" element={<><RangePicker value={range} onChange={setRange} /><AdminFleet range={range} now={now} /></>} />
          <Route path="users" element={<><RangePicker value={range} onChange={setRange} /><AdminUsers range={range} now={now} /></>} />
          <Route path="segments" element={<AdminSegments />} />
          <Route path="projects" element={<AdminProjects now={now} />} />
          <Route path="usage" element={<><RangePicker value={range} onChange={setRange} /><AdminUsage range={range} /></>} />
          <Route path="cloud" element={<><RangePicker value={range} onChange={setRange} /><AdminCloud range={range} now={now} /></>} />
          <Route path="prs" element={<AdminPrs now={now} />} />
          <Route path="software" element={<AdminSoftware now={now} />} />
          <Route path="system" element={<AdminSystem now={now} />} />
          <Route path="settings" element={<AdminSettings range={range} now={now} onRange={setRange} />} />
          <Route path="*" element={<Navigate to="." replace />} />
        </Routes>
        <footer className="dash-footer usage-dim">
          Aggregates and metadata only; no terminal contents. Token days are UTC, working-time days are server-local. Every view here is audited.
        </footer>
      </div>
    </div>
  );
}
