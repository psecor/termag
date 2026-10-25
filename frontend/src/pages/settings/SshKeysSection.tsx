import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { sshKeysApi, SshKeyInfo } from '../../services/api';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { sshKeyNotice, SshKeyNotice } from './sshKeyNotice';
import { DocsLink } from './DocsLink';
import { recordProductEvent } from '../../observability';

function apiError(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback;
}

export interface SshKeysSectionHandle {
  hasDraft: boolean;
  busy: boolean;
  addDraft: () => Promise<boolean>;
  focusDraft: () => void;
}

export const SshKeysSection = forwardRef<SshKeysSectionHandle, { onBusyChange?: (busy: boolean) => void }>(function SshKeysSection({ onBusyChange }, ref) {
  const [keys, setKeys] = useState<SshKeyInfo[] | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  // The list failed to load, so an empty `keys` says nothing about the account.
  const [loadFailed, setLoadFailed] = useState(false);
  const [notice, setNotice] = useState<SshKeyNotice | null>(null);
  // Each change waits for the running boxes to be rewritten, which can take a few seconds.
  const [busy, setBusy] = useState(false);
  const changing = useRef(false);
  const mounted = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [confirming, setConfirming] = useState<SshKeyInfo | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; onBusyChange?.(false); };
  }, [onBusyChange]);

  useEffect(() => {
    sshKeysApi.list().then(keys => { if (mounted.current) setKeys(keys); }).catch(err => {
      if (mounted.current) { setKeys([]); setLoadFailed(true); setError(apiError(err, 'Failed to load SSH keys')); }
    });
  }, []);

  async function change(run: () => Promise<SshKeyNotice>, fallback: string): Promise<boolean> {
    if (!mounted.current || changing.current) return false;
    changing.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError('');
    setNotice(null);
    try {
      const notice = await run();
      if (!mounted.current) return false;
      setNotice(notice);
      return true;
    } catch (err) {
      if (mounted.current) setError(apiError(err, fallback));
      return false;
    } finally {
      changing.current = false;
      if (mounted.current) {
        setBusy(false);
        onBusyChange?.(false);
        if (document.activeElement === document.body) inputRef.current?.focus();
      }
    }
  }

  async function addDraft(): Promise<boolean> {
    if (!draft.trim()) return false;
    return change(async () => {
      try {
        const { boxes, ...key } = await sshKeysApi.add(draft.trim());
        // The key's type and how many boxes took it; never the key.
        recordProductEvent('sshkey.added', { 'termag.keyType': key.type, 'termag.boxesUpdated': boxes?.updated.length ?? 0 });
        if (mounted.current) { setKeys(prev => [...(prev ?? []), key]); setDraft(''); }
        return sshKeyNotice('added', boxes);
      } catch (err) {
        // The endpoint identifies a duplicate by fingerprint. Confirm that key
        // still exists, including when an earlier successful response was lost.
        const status = (err as { response?: { status?: number } })?.response?.status;
        const duplicate = /^Key (SHA256:[A-Za-z0-9+/]+) is already registered$/.exec(apiError(err, ''));
        if (status !== 409 || !duplicate || !mounted.current) throw err;
        const saved = await sshKeysApi.list();
        if (!saved.some(key => key.fingerprint === duplicate[1])) throw err;
        if (mounted.current) { setKeys(saved); setDraft(''); }
        return { text: 'Key is already registered.', warn: false };
      }
    }, 'Failed to add SSH key');
  }

  function editDraft(value: string) {
    // Reject recognizable private-key pastes before they enter React state or
    // can be sent to the public-key API. Public OpenSSH comments stay valid.
    if (/^\s*(?:-----BEGIN [^-]*PRIVATE KEY-----|---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----)/i.test(value)) {
      setDraft('');
      setError('That looks like a private key. Paste the public key from the .pub file instead.');
      return;
    }
    setDraft(value);
    setError('');
  }

  // The wizard can offer to save before it unmounts this form. Settings keeps
  // the same standalone Add key flow; both paths use the same save operation.
  useImperativeHandle(ref, () => ({
    hasDraft: !!draft.trim(),
    get busy() { return changing.current; },
    addDraft,
    focusDraft: () => inputRef.current?.focus(),
  }));

  function remove(key: SshKeyInfo) {
    void change(async () => {
      const { boxes } = await sshKeysApi.remove(key.id);
      if (mounted.current) setKeys(prev => (prev ?? []).filter(k => k.id !== key.id));
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
        {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError('')}>×</button></div>}
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
          {keys?.length === 0 && !loadFailed && <li className="settings-empty">No SSH keys yet. Add a public key below to reach your boxes over SSH.</li>}
        </ul>
        <form className="inline-form settings-form" onSubmit={e => { e.preventDefault(); void addDraft(); }}>
          <input
            ref={inputRef}
            value={draft}
            readOnly={busy}
            onChange={e => editDraft(e.target.value)}
            placeholder="paste the contents of ~/.ssh/id_ed25519.pub"
            aria-label="SSH public key"
            spellCheck={false}
          />
          <button type="submit" data-analytics="sshkey-add" aria-label="Add SSH key" disabled={busy || !draft.trim()}>{busy ? 'Updating boxes…' : 'Add key'}</button>
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
          confirmLabel="Remove key"
          onConfirm={() => { const k = confirming; setConfirming(null); remove(k); }}
          onCancel={() => setConfirming(null)}
        />,
        document.body,
      )}
    </section>
  );
});
