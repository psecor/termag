import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { cliDevicesApi, CliDeviceInfo } from '../../services/api';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { DocsLink } from './DocsLink';

function apiError(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback;
}

export function CliDevicesSection() {
  const [devices, setDevices] = useState<CliDeviceInfo[] | null>(null);
  const [error, setError] = useState('');
  // The list failed to load, so an empty `devices` says nothing about the account.
  const [loadFailed, setLoadFailed] = useState(false);
  const [confirming, setConfirming] = useState<CliDeviceInfo | null>(null);

  useEffect(() => {
    cliDevicesApi.list().then(setDevices).catch(err => { setDevices([]); setLoadFailed(true); setError(apiError(err, 'Failed to load CLI sign-ins')); });
  }, []);

  async function signOut(device: CliDeviceInfo) {
    setError('');
    try {
      await cliDevicesApi.revoke(device.id);
      setDevices(prev => (prev ?? []).filter(d => d.id !== device.id));
    } catch (err) {
      setError(apiError(err, 'Failed to sign the device out'));
    }
  }

  return (
    <section className="dash-section" aria-labelledby="cli-devices-h">
      <div className="dash-section-title" id="cli-devices-h">
        CLI sign-ins <DocsLink anchor="cli-sign-ins" topic="CLI sign-ins" />
        {devices && devices.length > 0 && <span className="dash-count">{devices.length}</span>}
      </div>
      <div className="dash-card">
        <p className="settings-hint">
          Devices signed in with <code>termag login</code>. A sign-in lapses after 7 days without
          use, and after 30 days regardless. Boxes don't appear here: the CLI on a box uses the
          box's own credentials.
        </p>
        {error && <div className="error-banner">{error}<button onClick={() => setError('')}>×</button></div>}
        <ul className="settings-list">
          {devices?.map(d => (
            <li key={d.id} className="settings-row">
              <div className="settings-row-text">
                <span className="settings-row-name">{d.deviceName}</span>
                <span className="settings-row-meta">
                  signed in {new Date(d.createdAt).toLocaleDateString()} · last used {new Date(d.lastUsedAt).toLocaleString()} ·
                  lapses {new Date(d.expiresAt).toLocaleString()} unless used
                </span>
                <span className="settings-row-mono">{d.tokenPrefix}</span>
              </div>
              <button className="btn-ghost" onClick={() => setConfirming(d)}>Sign out</button>
            </li>
          ))}
          {devices?.length === 0 && !loadFailed && <li className="settings-empty">No devices signed in. To add one, run <code>termag login</code> on a laptop.</li>}
        </ul>
      </div>
      {confirming && createPortal(
        <ConfirmDialog
          message={<>
            Sign out the termag CLI on <strong>{confirming.deviceName}</strong>? It will need
            {' '}<code>termag login</code> again.
          </>}
          confirmLabel="Sign out"
          tone="primary"
          onConfirm={() => { const d = confirming; setConfirming(null); void signOut(d); }}
          onCancel={() => setConfirming(null)}
        />,
        document.body,
      )}
    </section>
  );
}
