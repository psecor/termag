import React, { useCallback, useState } from 'react';
import { adminApi, type AdminRange, type AdminToken, type AuditRow } from '../../services/adminApi';
import { ChartCard } from '../dashboard/ChartCard';
import { useAdminPolled, pendingText, DataTable, fmtAgo, fmtUntil, type Column } from './shared';
import { RangePicker } from '../dashboard/RangePicker';
import { REPLAY_BLOCK_CLASS } from '../../observability';

export function AdminSettings({ range, now, onRange }: { range: AdminRange; now: number; onRange: (r: AdminRange) => void }) {
  const admins = useAdminPolled(useCallback(() => adminApi.admins(), []), 60_000);
  const tokens = useAdminPolled(useCallback(() => adminApi.adminTokens(), []), 60_000);
  const audit = useAdminPolled(useCallback(() => adminApi.audit(range, 300), [range]), 60_000, { deps: [range] });
  const [grantId, setGrantId] = useState('');
  const [name, setName] = useState('');
  const [days, setDays] = useState('90');
  const [minted, setMinted] = useState<{ token: string; name: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>, after: () => void) => {
    setErr(null);
    try { await fn(); after(); } catch (e) { setErr((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? (e as Error).message); }
  };

  const tcols: Column<AdminToken>[] = [
    { id: 'name', label: 'token', value: r => r.name, render: r => <span>{r.name} <span className="usage-dim">{r.tokenPrefix}</span></span> },
    { id: 'owner', label: 'owner', value: r => r.owner?.unixUsername ?? '', render: r => r.owner ? <span>{r.owner.unixUsername}{r.owner.stillAdmin ? '' : <span className="admin-bad"> (no longer admin)</span>}</span> : <span className="admin-bad">no owner</span> },
    { id: 'created', label: 'created', value: r => Date.parse(r.createdAt), render: r => fmtAgo(r.createdAt, now) },
    { id: 'used', label: 'last used', value: r => r.lastUsedAt ? Date.parse(r.lastUsedAt) : null, render: r => fmtAgo(r.lastUsedAt, now) },
    { id: 'exp', label: 'expires', value: r => r.expiresAt ? Date.parse(r.expiresAt) : null, render: r => r.expiresAt ? (r.expired ? <span className="admin-bad">{fmtUntil(r.expiresAt, now)}</span> : fmtUntil(r.expiresAt, now)) : 'never' },
    { id: 'state', label: 'state', value: r => r.revokedAt ? 'revoked' : r.expired ? 'expired' : 'active',
      render: r => r.revokedAt ? 'revoked' : <button type="button" className="btn-ghost btn-tiny" onClick={() => void act(() => adminApi.revokeAdminToken(r.id), tokens.refresh)}>revoke</button> },
  ];
  const acols: Column<AuditRow>[] = [
    { id: 'at', label: 'when', value: r => Date.parse(r.at), render: r => fmtAgo(r.at, now) },
    { id: 'actor', label: 'actor', value: r => r.actor, render: r => <span>{r.actor}{r.tokenId ? <span className="usage-dim"> (token)</span> : ''}</span> },
    { id: 'surface', label: 'via', value: r => r.surface },
    { id: 'action', label: 'action', value: r => r.action },
    { id: 'args', label: 'args', value: r => r.args ? JSON.stringify(r.args) : null, render: r => <span className="usage-dim admin-mono">{r.args ? JSON.stringify(r.args) : ''}</span> },
    { id: 'outcome', label: 'outcome', value: r => r.outcome, render: r => <span className={r.outcome === 'ok' ? '' : 'admin-bad'}>{r.outcome}{r.status ? ` ${r.status}` : ''}</span> },
  ];

  return (
    <>
      {err && <div className="admin-error">{err}</div>}
      <div className="dash-grid-2">
        <ChartCard title="Admins" subtitle={admins.data ? (admins.data.envConfigured ? 'ADMIN_USERS is set; those entries cannot be demoted here' : 'ADMIN_USERS is unset; only granted admins exist') : pendingText(admins)} stale={admins.loading}>
          <div className="dash-rows">
            {(admins.data?.admins ?? []).map(a => (
              <div className="dash-row" key={a.id}>
                <span className="dash-row-label">{a.unixUsername}</span>
                <span className="usage-dim">{a.email} · {a.source} · seen {fmtAgo(a.lastSeenAt, now)}</span>
                {a.demotable && <button type="button" className="btn-ghost btn-tiny" style={{ marginLeft: 'auto' }} onClick={() => void act(() => adminApi.setRole(a.id, 'member'), admins.refresh)}>revoke</button>}
              </div>
            ))}
          </div>
          <form className="admin-form" onSubmit={e => { e.preventDefault(); if (grantId.trim()) void act(() => adminApi.setRole(grantId.trim(), 'admin'), () => { setGrantId(''); admins.refresh(); }); }}>
            <input value={grantId} onChange={e => setGrantId(e.target.value)} placeholder="user id (from the Users tab)" />
            <button type="submit" className="btn-ghost btn-tiny" disabled={!grantId.trim()}>grant admin</button>
          </form>
        </ChartCard>
        <ChartCard title="Admin tokens" subtitle="for MCP and scripts; shown once at mint time; disabled when the owner loses admin" stale={tokens.loading}>
          <form className="admin-form" onSubmit={e => {
            e.preventDefault();
            const d = days.trim() === '' ? null : parseInt(days, 10);
            void act(async () => { const t = await adminApi.mintAdminToken(name.trim(), d); setMinted({ token: t.token, name: t.name }); }, () => { setName(''); tokens.refresh(); });
          }}>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="name (e.g. laptop claude-code)" maxLength={80} />
            <input value={days} onChange={e => setDays(e.target.value)} placeholder="days" style={{ width: 60 }} title="expiry in days; blank = never" />
            <button type="submit" className="btn-ghost btn-tiny" disabled={!name.trim()}>mint</button>
          </form>
          {minted && (
            <div className={`admin-minted ${REPLAY_BLOCK_CLASS}`}>
              <div className="usage-dim">Token for <b>{minted.name}</b>. Copy it now; it will not be shown again.</div>
              <code className="admin-mono">{minted.token}</code>
              <pre className="admin-mono usage-dim">{`claude mcp add --transport http termag-admin ${window.location.origin}/termag/mcp/admin --header "Authorization: Bearer ${minted.token}"`}</pre>
              <button type="button" className="btn-ghost btn-tiny" onClick={() => setMinted(null)}>dismiss</button>
            </div>
          )}
          <DataTable rows={tokens.data ?? []} columns={tcols} rowKey={r => r.id} defaultSort="created" dense empty="no admin tokens" />
        </ChartCard>
      </div>
      <RangePicker value={range} onChange={onRange} />
      <section className="dash-section">
        <div className="dash-section-title">Audit log {audit.data && <span className="dash-count">{audit.data.rows.length}</span>}<span className="usage-dim">every admin REST request and MCP tool call in the selected range (newest {audit.data?.limit ?? 300})</span></div>
        <DataTable rows={audit.data?.rows ?? []} columns={acols} rowKey={r => r.id} defaultSort="at" dense empty={audit.data ? 'nothing yet' : pendingText(audit)} />
      </section>
    </>
  );
}
