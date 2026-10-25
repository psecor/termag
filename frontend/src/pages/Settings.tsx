import React, { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { CredentialsSection } from './settings/CredentialsSection';
import { SshKeysSection } from './settings/SshKeysSection';
import { DotfilesSection } from './settings/DotfilesSection';
import { CliDevicesSection } from './settings/CliDevicesSection';
import { AppearanceSection } from './settings/AppearanceSection';
import { BriefingSection } from './settings/BriefingSection';
import { McpSection } from './settings/McpSection';
import { NotificationsSection } from './settings/NotificationsSection';
import { DocsLink } from './settings/DocsLink';
import { settingsBackLink } from './settings/backLink';

/**
 * Account-level settings: things set once that apply to every box and project.
 * Its own route like /dashboard, so it opens no status WebSocket, no terminals
 * and sends no human heartbeat. Each section is one component under settings/.
 */
export default function Settings() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const back = settingsBackLink(location.search);
  // A link to a section (/settings#notifications, #briefing): the router does not scroll to it.
  useEffect(() => {
    const id = location.hash.slice(1);
    if (!id) return;
    const t = window.setTimeout(() => document.getElementById(id)?.scrollIntoView?.({ block: 'start' }), 50);
    return () => window.clearTimeout(t);
  }, [location.hash]);
  return (
    <div className="dash-root">
      <div className="dash-page settings-page">
        <header className="dash-header">
          <h1>Settings</h1>
          <Link to={back.to}>{back.label}</Link>
          <span className="dash-updated">{user?.email}</span>
        </header>
        <SshKeysSection />
        <CredentialsSection />
        <McpSection focus={location.pathname.endsWith('/settings/mcp')} search={location.search} />
        <DotfilesSection />
        <CliDevicesSection />
        <BriefingSection />
        <NotificationsSection />
        <AppearanceSection />
        {/* Sign out lives here rather than the sidebar header: rarely used, and
            the header slot is better spent on the Recents switcher. */}
        <section className="dash-section settings-account" aria-labelledby="account-h">
          <div className="dash-section-title" id="account-h">
            <span>Account</span> <DocsLink anchor="account" topic="Account" />
          </div>
          <div className="dash-card settings-account-card">
            <span className="usage-dim">Signed in as {user?.email}</span>
            <span className="settings-account-actions">
              <Link className="btn-ghost" to="/welcome" title="Walk through SSH key, GitHub, dotfiles, box and first project again">Run first-time setup</Link>
              <button className="btn-ghost" onClick={logout}>Sign out</button>
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}
