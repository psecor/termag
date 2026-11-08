// The fields of the redrawn first run: a
// GitHub token, and the optional SSH key and dotfiles repository. Each is one
// LaunchPad field with one line of help, calling the same endpoints as its
// Settings section (settings/GithubCredential.tsx, SshKeysSection.tsx,
// DotfilesSection.tsx), which keep the full explanations.
import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Button, FieldError, Form, Input, Label, Text, TextField } from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { useAuth } from '../../contexts/AuthContext';
import { credentialsApi, sshKeysApi, type CredentialsStatus } from '../../services/api';
import { recordProductEvent } from '../../observability';
import type { SshKeysSectionHandle } from '../settings/SshKeysSection';

function apiError(err: unknown, fallback: string): string {
  const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
  return typeof msg === 'string' && msg ? msg : fallback;
}

/** The GitHub token: one field, or the connected account with Replace. */
export function GithubField({ status, onChanged }: { status: CredentialsStatus['github'] | null; onChanged: () => Promise<void> }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [replacing, setReplacing] = useState(false);
  const connected = status?.available ? status.connected : undefined;

  async function connect() {
    if (!token.trim() || busy || !status?.available) return;
    setBusy(true); setError('');
    try {
      await credentialsApi.connectGithub(token.trim());
      recordProductEvent('welcome.github.connected', { 'termag.replaced': replacing });
      setToken(''); setReplacing(false);
      await onChanged();
    } catch (err) {
      setError(apiError(err, 'Could not connect GitHub'));
    } finally {
      setBusy(false);
    }
  }

  if (connected && !replacing) {
    const orgs = Object.keys(connected.orgs ?? {});
    return (
      <div className="wel-connected">
        <Icon name="check-circle" size="medium" className="wel-ok" aria-hidden="true" />
        <span className="wel-connected-text">
          <span>Connected as <strong>{connected.label}</strong></span>
          {orgs.length > 0 && <span className="wel-dim">Access to {orgs.join(', ')}</span>}
        </span>
        <Button variant="minimal" size="small" onPress={() => setReplacing(true)}>Replace</Button>
      </div>
    );
  }

  const unavailable = !!status && !status.available;
  return (
    <Form className="wel-inline-form" onSubmit={e => { e.preventDefault(); void connect(); }} validationErrors={error ? { token: error } : undefined}>
      <TextField name="token" type="password" value={token} onChange={v => { setToken(v); setError(''); }} isDisabled={!status || unavailable || busy} className="wel-field">
        <Label>GitHub token</Label>
        <Input placeholder={unavailable ? 'Not available on this orchestrator' : 'Paste the token'} autoComplete="off" />
        <Text slot="description">
          {unavailable
            ? <>This orchestrator has no credential store. Sign in to GitHub on each box with <code>gh auth login</code> instead.</>
            : <>Run <code>gh auth token</code> on your laptop. Needs repo and read:org. Optional: workflow, so agents can push changes to <code>.github/workflows</code> (<code>gh auth refresh -h github.com -s workflow</code> adds it).</>}
        </Text>
        <FieldError />
      </TextField>
      <Button type="submit" variant="primary" isDisabled={!token.trim() || busy || unavailable}>{busy ? 'Connecting…' : 'Connect'}</Button>
    </Form>
  );
}

const PRIVATE_KEY = /^\s*(?:-----BEGIN [^-]*PRIVATE KEY-----|---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----)/i;
const DUPLICATE = /^Key (SHA256:[A-Za-z0-9+/]+) is already registered$/;

/**
 * An SSH public key, as Settings' SshKeysSection adds one (the same handle, so
 * the wizard can offer to add a typed key before it leaves): a private-key
 * paste is cleared and never sent, and a key the server calls a duplicate
 * counts as saved only once a refreshed list has its fingerprint.
 */
export const SshKeyField = forwardRef<SshKeysSectionHandle, { onBusyChange?: (busy: boolean) => void }>(function SshKeyField({ onBusyChange }, ref) {
  const [draft, setDraft] = useState('');
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const changing = useRef(false);
  const mounted = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mounted.current = true;
    sshKeysApi.list().then(k => { if (mounted.current) setCount(k.length); }).catch(() => {});
    return () => { mounted.current = false; onBusyChange?.(false); };
  }, [onBusyChange]);

  async function addDraft(): Promise<boolean> {
    const key = draft.trim();
    if (!key || !mounted.current || changing.current) return false;
    changing.current = true;
    setBusy(true); onBusyChange?.(true); setError(''); setSaved('');
    try {
      try {
        const { boxes, ...added } = await sshKeysApi.add(key);
        recordProductEvent('sshkey.added', { 'termag.keyType': added.type, 'termag.boxesUpdated': boxes?.updated.length ?? 0 });
        if (mounted.current) { setDraft(''); setCount(c => (c ?? 0) + 1); setSaved('Key added.'); }
      } catch (err) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        const duplicate = DUPLICATE.exec(apiError(err, ''));
        if (status !== 409 || !duplicate || !mounted.current) throw err;
        const list = await sshKeysApi.list();
        if (!list.some(k => k.fingerprint === duplicate[1])) throw err;
        if (mounted.current) { setDraft(''); setCount(list.length); setSaved('That key is already added.'); }
      }
      return mounted.current;
    } catch (err) {
      if (mounted.current) setError(apiError(err, 'Could not add the key'));
      return false;
    } finally {
      changing.current = false;
      if (mounted.current) { setBusy(false); onBusyChange?.(false); }
    }
  }

  function edit(value: string) {
    setSaved('');
    if (PRIVATE_KEY.test(value)) {
      setDraft('');
      setError('That looks like a private key. Paste the public key from the .pub file instead.');
      return;
    }
    setDraft(value);
    setError('');
  }

  useImperativeHandle(ref, () => ({
    hasDraft: !!draft.trim(),
    get busy() { return changing.current; },
    addDraft,
    focusDraft: () => inputRef.current?.focus(),
  }));

  const help = saved || (count ? `${count} key${count === 1 ? '' : 's'} added. ` : '');
  return (
    <Form className="wel-inline-form" onSubmit={e => { e.preventDefault(); void addDraft(); }} validationErrors={error ? { ssh: error } : undefined}>
      <TextField name="ssh" value={draft} onChange={edit} isReadOnly={busy} className="wel-field">
        <Label>SSH public key</Label>
        <Input ref={inputRef} placeholder="ssh-ed25519 AAAA… you@laptop" spellCheck={false} />
        <Text slot="description">
          {saved ? saved : <>{help}Lets you ssh into your boxes. Paste <code>~/.ssh/id_ed25519.pub</code>.</>}
        </Text>
        <FieldError />
      </TextField>
      <Button type="submit" isDisabled={!draft.trim() || busy}>{busy ? 'Adding…' : 'Add'}</Button>
    </Form>
  );
});

/** The dotfiles repository, saved to the user like Settings → Dotfiles. */
export function DotfilesField() {
  const { user, updateDotfilesRepoUrl } = useAuth();
  const saved = user?.dotfilesRepoUrl ?? '';
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => { setDraft(saved); }, [saved]);

  async function save() {
    if (busy) return;
    setBusy(true); setError(''); setDone(false);
    try {
      await updateDotfilesRepoUrl(draft.trim() || null);
      recordProductEvent('welcome.dotfiles.saved', { 'termag.cleared': !draft.trim() });
      setDone(true);
    } catch (err) {
      setError(apiError(err, 'Could not save the repository'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Form className="wel-inline-form" onSubmit={e => { e.preventDefault(); void save(); }} validationErrors={error ? { dotfiles: error } : undefined}>
      <TextField name="dotfiles" value={draft} onChange={v => { setDraft(v); setError(''); setDone(false); }} isDisabled={busy} className="wel-field">
        <Label>Dotfiles repository</Label>
        <Input placeholder="https://github.com/you/dotfiles" spellCheck={false} />
        <Text slot="description">{done ? 'Saved. Your next new box gets it.' : 'Your shell and editor settings, applied to each new box.'}</Text>
        <FieldError />
      </TextField>
      <Button type="submit" isDisabled={busy || draft.trim() === saved}>{busy ? 'Saving…' : 'Save'}</Button>
    </Form>
  );
}
