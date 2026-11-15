import { useEffect, useState } from 'react';
import { Alert, Button, FieldError, Form, Input, Label, Text, TextField } from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { credentialsApi, type CredentialsStatus, type FireworksKeyStatus } from '../../services/api';
import { LP_THEME } from '../../launchpad/theme';
import { ensureLaunchPadSprite } from '../../launchpad/sprite';
import { DocsLink } from './DocsLink';
import './fireworksCredential.css';

function apiError(err: unknown, fallback: string): string {
  const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
  return typeof msg === 'string' && msg ? msg : fallback;
}

/** "14 May 2027", in the viewer's locale; the raw value when it is not a date. */
export function fireworksDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Who the stored key belongs to, as far as Fireworks said. */
export function fireworksOwnerLine(key: FireworksKeyStatus): string {
  if (key.owner && key.account) return `Belongs to ${key.owner}, in the Fireworks account ${key.account}.`;
  if (key.owner) return `Belongs to ${key.owner}.`;
  if (key.account) return `In the Fireworks account ${key.account}.`;
  return 'Accepted by Fireworks.';
}

interface Props {
  status: NonNullable<CredentialsStatus['fireworks']>;
  /** Re-read /api/credentials after a change. */
  onChanged: () => Promise<void>;
}

/**
 * The Fireworks row of "Credentials on your boxes": the person's own
 * Fireworks API key. It stays on the orchestrator; the gateway sends it to
 * Fireworks in place of the box's token, so Fireworks attributes and budgets
 * those calls to its owner.
 * Built from LaunchPad's field, button and alert. The row shows only the
 * field, its buttons and the key's state; how it works is in the docs its
 * label links to.
 */
export function FireworksCredential({ status, onChanged }: Props) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [replacing, setReplacing] = useState(false);
  useEffect(() => { ensureLaunchPadSprite(); }, []);

  const stored = status.key;
  const showField = !stored || replacing || !!stored.invalid;

  async function save() {
    if (!key.trim() || busy) return;
    setBusy(true); setError('');
    try {
      await credentialsApi.saveFireworksKey(key.trim());
      setKey(''); setReplacing(false);
      await onChanged();
    } catch (err) {
      setError(apiError(err, 'Could not save the Fireworks key'));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await credentialsApi.removeFireworksKey();
      setReplacing(false);
      await onChanged();
    } catch (err) {
      setError(apiError(err, 'Could not remove the Fireworks key'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`${LP_THEME} credentials-row fw-key`}>
      <div className="credentials-label">
        Fireworks <DocsLink anchor="fireworks-api-key" topic="Fireworks API key" />
      </div>

      {stored?.invalid && (
        <Alert status="error" className="fw-key-alert">
          <Text elementType="p">
            {stored.invalid.reason === 'expired'
              ? `Your Fireworks key (${stored.hint}) expired on ${fireworksDate(stored.invalid.at)}.`
              : `Fireworks rejected your key (${stored.hint}).`}{' '}
            Your boxes' Fireworks calls are refused until you paste a new one.
          </Text>
        </Alert>
      )}
      {stored && !stored.invalid && stored.expiresSoon && stored.expireTime && (
        <Alert status="warning" className="fw-key-alert">
          <Text elementType="p">Your Fireworks key ({stored.hint}) expires on {fireworksDate(stored.expireTime)}. Create a new one in Fireworks and paste it here.</Text>
        </Alert>
      )}
      {status.unreadable && (
        <Alert status="warning" className="fw-key-alert">
          <Text elementType="p">termag could not read your stored Fireworks key. Paste it again.</Text>
        </Alert>
      )}

      {stored && (
        <div className="fw-key-stored">
          <Icon name={stored.invalid ? 'warning' : 'check-circle'} size="medium" className={stored.invalid ? 'fw-key-bad' : 'fw-key-ok'} aria-hidden="true" />
          <span className="fw-key-text">
            <span>Key <code>{stored.hint}</code>{stored.invalid ? ' (not in use)' : ' (in use for your Fireworks calls)'}</span>
            <span className="fw-key-dim">{fireworksOwnerLine(stored)}</span>
            {stored.expireTime && !stored.invalid && <span className="fw-key-dim">Expires on {fireworksDate(stored.expireTime)}.</span>}
          </span>
          <span className="fw-key-actions">
            {!showField && <Button variant="minimal" size="small" onPress={() => setReplacing(true)} isDisabled={busy}>Replace</Button>}
            <Button variant="minimal" size="small" onPress={() => void remove()} isDisabled={busy}>Remove from termag</Button>
          </span>
        </div>
      )}

      {showField && (
        <Form className="fw-key-form" onSubmit={e => { e.preventDefault(); void save(); }} validationErrors={error ? { fireworksKey: error } : undefined}>
          <TextField name="fireworksKey" type="password" value={key} onChange={v => { setKey(v); setError(''); }} isDisabled={busy} className="fw-key-field">
            <Label>{stored ? 'New Fireworks API key' : 'Fireworks API key'}</Label>
            <Input placeholder="Paste the key from Fireworks' API Keys page" autoComplete="off" spellCheck={false} />
            <FieldError />
          </TextField>
          <span className="fw-key-form-actions">
            <Button type="submit" variant="primary" isDisabled={!key.trim() || busy}>{busy ? 'Checking…' : 'Save'}</Button>
            {replacing && <Button variant="minimal" onPress={() => { setReplacing(false); setKey(''); setError(''); }}>Cancel</Button>}
          </span>
        </Form>
      )}
      {!showField && error && <div className="credentials-error">{error}</div>}
    </div>
  );
}
