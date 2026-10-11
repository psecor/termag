import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { sshKeysApi, SshKeyInfo } from '../../services/api';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { sshKeyNotice, SshKeyNotice } from './sshKeyNotice';
import { DocsLink } from './DocsLink';

function apiError(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback;
}

export function SshKeysSection() {
  const [keys, setKeys] = useState<SshKeyInfo[] | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<SshKeyNotice | null>(null);
  // Each change waits for the running boxes to be rewritten, which can take a few seconds.
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<SshKeyInfo | null>(null);

  useEffect(() => {
    sshKeysApi.list().then(setKeys).catch(err => { setKeys([]); setError(apiError(err, 'Failed to load SSH keys')); });
  }, []);

  async function change(run: () => Promise<SshKeyNotice>, fallback: string) {
    setBusy(true);
    setError('');
    setNotice(null);
    try {
      setNotice(await run());
    } catch (err) {
      setError(apiError(err, fallback));
    } finally {
      setBusy(false);
    }
  }

  function add(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim() || busy) return;
    void change(async () => {
      const { boxes, ...key } = await sshKeysApi.add(draft.trim());
      setKeys(prev => [...(prev ?? []), key]);
      setDraft('');
      return sshKeyNotice('added', boxes);
    }, 'Failed to add SSH key');
  }

  function remove(key: SshKeyInfo) {
    void change(async () => {
      const { boxes } = await sshKeysApi.remove(key.id);
      setKeys(prev => (prev ?? []).filter(k => k.id !== key.id));
      return sshKeyNotice('removed', boxes);
    }, 'Failed to remove SSH key');
  }

  return (
    <section className="dash-section" aria-labelledby="ssh-keys-h">
      <div className="dash-section-title" id="ssh-keys-h">
        SSH keys <DocsLink anchor="ssh-keys" topic="SSH keys" />
        {keys && keys.length > 0 && <span className="dash-count">{keys.length}</span>}
      </div>
      <div className="dash-card">
        <p className="settings-hint">
          Public keys from your laptops. Every box you own accepts them for ssh, scp and port
          forwarding over TermagSSH, including boxes that are already running. Keys added to a
          box's <code>~/.ssh/authorized_keys</code> by hand are left alone.{' '}
          <DocsLink anchor="ssh-into-a-box" topic="SSH into a box over SSM" />
        </p>
        {error && <div className="error-banner">{error}<button onClick={() => setError('')}>×</button></div>}
        {notice && (
          <div className={`settings-notice${notice.warn ? ' warn' : ''}`} role="status">
            {notice.text}<button onClick={() => setNotice(null)}>×</button>
          </div>
        )}
        <ul className="settings-list">
          {keys?.map(k => (
            <li key={k.id} className="settings-row">
              <div className="settings-row-text">
                <span className="settings-row-name">{k.comment || k.type}</span>
                <span className="settings-row-meta">
                  {k.type} · {k.bits} bits · added {new Date(k.createdAt).toLocaleDateString()}
                </span>
                <span className="settings-row-mono">{k.fingerprint}</span>
              </div>
              <button className="btn-ghost" disabled={busy} onClick={() => setConfirming(k)}>Remove</button>
            </li>
          ))}
          {keys?.length === 0 && <li className="settings-empty">No SSH keys yet.</li>}
        </ul>
        <form className="inline-form settings-form" onSubmit={add}>
          <input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder="paste the contents of ~/.ssh/id_ed25519.pub"
            aria-label="SSH public key"
            spellCheck={false}
          />
          <button type="submit" disabled={busy || !draft.trim()}>{busy ? 'Updating boxes…' : 'Add key'}</button>
        </form>
      </div>
      {confirming && createPortal(
        <ConfirmDialog
          message={<>
            Remove SSH key <strong>{confirming.comment || confirming.type}</strong>?
            <code className="confirm-code">{confirming.fingerprint}</code>
            It is taken out of the termag-managed keys on every box you own. A copy added
            to a box's authorized_keys by hand stays.
          </>}
          onConfirm={() => { const k = confirming; setConfirming(null); remove(k); }}
          onCancel={() => setConfirming(null)}
        />,
        document.body,
      )}
    </section>
  );
}
