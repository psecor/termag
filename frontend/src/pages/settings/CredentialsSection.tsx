import { useEffect, useState } from 'react';
import { credentialsApi, CredentialsStatus } from '../../services/api';
import { GithubCredential } from './GithubCredential';
import { DocsLink } from './DocsLink';

function apiError(err: unknown, fallback: string): string {
  const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
  return typeof msg === 'string' ? msg : fallback;
}

// "Log in once" settings: what termag delivers to every box you own. A
// self-contained section of the account Settings page. The GitHub row lives in
// GithubCredential so the first-run wizard shows the same thing.
export function CredentialsSection() {
  const [status, setStatus] = useState<CredentialsStatus | null>(null);
  const [error, setError] = useState('');

  const load = () => credentialsApi.get().then(setStatus).catch(err => setError(apiError(err, 'Could not load credentials')));
  useEffect(() => { void load(); }, []);

  async function toggleGateway(enabled: boolean) {
    setError('');
    try {
      await credentialsApi.setClaudeGateway(enabled);
      setStatus(s => s && { ...s, claudeGateway: { ...s.claudeGateway, enabled } });
    } catch (err) {
      setError(apiError(err, 'Could not save the Claude setting'));
    }
  }

  return (
    <section className="dash-section" aria-labelledby="credentials-h">
      <div className="dash-section-title" id="credentials-h">
        Credentials on your boxes
        <DocsLink anchor="credentials-on-your-boxes" topic="Credentials on your boxes" />
      </div>
      <div className="dash-card">
      {status && (
        <>
          <div className="credentials-row">
            <label>
              <input
                type="checkbox"
                checked={status.claudeGateway.enabled}
                disabled={!status.claudeGateway.available}
                onChange={e => toggleGateway(e.target.checked)}
              />
              Claude through the termag gateway
              <DocsLink anchor="claude-through-the-gateway" topic="Claude through the termag gateway" />
            </label>
            <div className="credentials-hint">
              {!status.claudeGateway.available
                ? 'Not set up on this orchestrator. Simple view can sign each box in to Claude Enterprise in the browser.'
                : status.claudeGateway.enabled
                  ? 'Your boxes are configured automatically. Off, or `termag-credentials skip claude-gateway` on one box, means signing that box in to Claude Enterprise. Simple view can do that in the browser.'
                  : 'Off. Simple view can sign each box in to Claude Enterprise in the browser.'}
            </div>
          </div>

          <GithubCredential status={status.github} onChanged={load} onError={setError} />
        </>
      )}
      {error && <div className="credentials-error">{error}</div>}
      </div>
    </section>
  );
}
