import React, { useRef, useState } from 'react';
import { credentialsApi, CredentialsStatus } from '../../services/api';
import { githubOrgLine } from './githubOrgCopy';
import { gateArmed } from '../../boxGate';
import { DocsLink } from './DocsLink';

function apiError(err: unknown, fallback: string): string {
  const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
  return typeof msg === 'string' ? msg : fallback;
}

interface Props {
  status: CredentialsStatus['github'];
  /** Re-read /api/credentials after a change. */
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
}

/**
 * The GitHub row of "Credentials on your boxes": paste the output of
 * `gh auth token`; the token stays on the orchestrator and every box reaches
 * GitHub through it. Shared by Settings and the first-run wizard so the
 * wording and behaviour cannot drift.
 *
 * The paste field is always rendered. When the orchestrator has no credential
 * store it is disabled with the reason, next to the per-box alternative, so a
 * new user learns what "GitHub on a box" means either way.
 */
export function GithubCredential({ status, onChanged, onError }: Props) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    if (!token.trim() || !status.available || inflight.current) return;
    inflight.current = true;
    setBusy(true);
    onError('');
    try {
      await credentialsApi.connectGithub(token.trim());
      setToken('');
      await onChanged();
    } catch (err) {
      onError(apiError(err, 'Could not connect GitHub'));
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }

  async function recheck() {
    if (!status.available || !status.connected || inflight.current) return;
    inflight.current = true;
    setBusy(true);
    onError('');
    try {
      await credentialsApi.recheckGithub();
      await onChanged();
    } catch (err) {
      onError(apiError(err, 'Could not re-check GitHub'));
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }

  async function disconnect() {
    if (inflight.current) return;
    onError('');
    try {
      await credentialsApi.disconnectGithub();
      await onChanged();
    } catch (err) {
      onError(apiError(err, 'Could not disconnect GitHub'));
    }
  }

  return (
    <div className="credentials-row">
      <div className="credentials-label">
        GitHub <DocsLink anchor="github-token" topic="GitHub token" />
      </div>
      {status.available && status.connected && (
        <ul className="token-list">
          <li className="token-item">
            <span className="token-prefix" title={status.connected.label}>{status.connected.label}</span>
            <button className="btn-tiny btn-danger" onClick={disconnect} disabled={busy} title="Disconnect">×</button>
          </li>
        </ul>
      )}
      {status.available && status.connected && (
        <div>
          {Object.entries(status.connected.orgs ?? {}).map(([org, access]) => {
            const line = githubOrgLine(org, access);
            return (
              <div className="credentials-hint" key={org}>
                {line.href ? <a href={line.href} rel="noreferrer">{line.text}</a> : line.text}
              </div>
            );
          })}
          <div className="inline-form">
            <button type="button" onClick={() => void recheck()} disabled={busy}>Re-check</button>
          </div>
        </div>
      )}
      <form className="inline-form" onSubmit={connect}>
        <input
          type="password"
          autoComplete="off"
          value={token}
          onChange={e => setToken(e.target.value)}
          disabled={!status.available || busy}
          placeholder={!status.available ? 'not available on this orchestrator' : status.connected ? 'replace: paste `gh auth token`' : 'paste `gh auth token`'}
          aria-label="GitHub token"
        />
        <button type="submit" disabled={!status.available || busy || !token.trim()}>{busy ? '…' : 'Save'}</button>
      </form>
      {status.available ? (
        <div className="credentials-hint">
          On your laptop: <code>gh auth token</code> (it needs the <code>repo</code> scope). The token stays on
          the orchestrator: your boxes' git and <code>gh</code> reach GitHub through it, and no GitHub
          key or token is put on a box. Disconnecting deletes it here, but encrypted backups keep it
          until they expire: to end the token, revoke it on GitHub.
          {gateArmed(status.boxGate) && ' A stored token is required to add boxes.'}
        </div>
      ) : (
        <div className="credentials-hint">
          Not set up on this orchestrator: authenticate on each box with <code>gh auth login</code> in the
          box's ctrl pane. Once the orchestrator has a credential store, paste the output of <code>gh auth token</code> here
          instead and every box you own is covered.
        </div>
      )}
    </div>
  );
}
