import { useEffect, useMemo, useRef, useState } from 'react';
import { mcpConnectorsApi, McpConnector, McpConnectorList, McpReturnTo } from '../../services/api';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PROVIDERS } from '../../providers/registry';
import { McpPasteLink, type PendingSignIn } from './McpPasteLink';
import { apiError, ConnectorNameLine, McpCatalogList, ServerName, useMcpSignIn, type BeginLink, type Failure } from './McpCatalog';
import { McpCallbackUrl } from './McpCallbackUrl';
import { McpPermissions } from './McpPermissions';
import { DocsLink } from './DocsLink';
import { connectorStatus, linkResult, mcpAgentNames, parseHeaderLines, referencedSecretNames, serverParam, suggestName } from './mcpForm';

const DEFAULT_HEADERS = 'Authorization: Bearer {{secret.token}}';

/** Write-only inputs for the secrets a set of headers names. */
function SecretInputs({ names, stored, values, onChange }: {
  names: string[];
  stored: string[];
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
}) {
  if (names.length === 0) return null;
  return (
    <div className="mcp-secrets">
      {names.map(n => (
        <label key={n} className="inline-form settings-form mcp-field">
          <span>secret.{n}</span>
          <input
            type="password"
            className="replay-block"
            autoComplete="off"
            value={values[n] ?? ''}
            placeholder={stored.includes(n) ? 'saved, type to replace' : 'value'}
            onChange={e => onChange(n, e.target.value)}
          />
        </label>
      ))}
    </div>
  );
}

/** One of the user's servers, in Settings and in the setup wizard's MCP step. */
export function ConnectorRow({ c, focused, signIn, returnTo, onLink, onChanged, onError }: {
  c: McpConnector;
  focused: boolean;
  // Where the paste box's answer returns the browser (McpCatalog.tsx useMcpSignIn).
  returnTo?: McpReturnTo;
  // This connector's sign-in open in a new tab, if any.
  signIn: PendingSignIn | null;
  onLink: BeginLink;
  onChanged: () => void;
  onError: (failure: Failure) => void;
}) {
  const [editing, setEditing] = useState(focused && c.missingSecrets.length > 0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const ref = useRef<HTMLLIElement>(null);
  const names = referencedSecretNames(c.headers);
  const linked = c.linkStatus === 'linked';
  const status = connectorStatus(c);

  useEffect(() => {
    if (!focused) return;
    ref.current?.scrollIntoView({ block: 'center' });
    if (c.missingSecrets.length > 0) setEditing(true);
  }, [focused]);

  async function saveSecrets() {
    const secrets = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ''));
    if (Object.keys(secrets).length === 0) { setEditing(false); return; }
    setBusy(true);
    try {
      await mcpConnectorsApi.update(c.id, { secrets });
      setValues({});
      setEditing(false);
      onChanged();
    } catch (err) {
      onError(apiError(err, 'Could not save the secrets'));
    } finally {
      setBusy(false);
    }
  }

  async function link() {
    setBusy(true);
    try {
      // Settings stays when the checklist or a new sign-in tab opens: the row is free again.
      if (await onLink(c)) setBusy(false);
    } catch (err) {
      onError(apiError(err, 'Could not start signing in to the server'));
      setBusy(false);
    }
  }
  const choosable = !!c.oauth?.scopeChoice;
  // What the server granted at the last sign-in, or what it was asked for when it didn't say.
  const permissions = linked ? (c.oauth?.grantedScopes ?? c.oauth?.requestedScopes ?? null) : null;

  async function unlink() {
    setBusy(true);
    try {
      await mcpConnectorsApi.unlinkOAuth(c.id);
      onChanged();
    } catch (err) {
      onError(apiError(err, 'Could not unlink the server'));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setConfirming(false);
    setBusy(true);
    try {
      await mcpConnectorsApi.remove(c.id);
      onChanged();
    } catch (err) {
      onError(apiError(err, 'Could not delete the connector'));
      setBusy(false);
    }
  }

  return (
    <li ref={ref} className={`settings-row mcp-row${focused ? ' mcp-row-focused' : ''}`}>
      <div className="settings-row-text">
        <span className="mcp-row-head">
          <ServerName display={c.displayName ?? c.name} name={c.name} kind={c.kind} />
          <span className={`settings-pill is-${status.tone}`}>{status.label}</span>
        </span>
        <ConnectorNameLine display={c.displayName ?? c.name} name={c.name} />
        <span className="settings-row-mono">{c.upstream}</span>
        <span className="settings-row-meta">{c.authType === 'static' ? 'API key' : c.kind === 'api' ? 'OAuth, REST API for a CLI (not an MCP server)' : 'OAuth'}</span>
        {permissions && permissions.length > 0 && (
          <McpPermissions granted={!!c.oauth?.grantedScopes} labels={permissions.map(s => s.label)} />
        )}
        {c.authType === 'oauth' && !linked && c.linkError && <span className="credentials-error">{c.linkError}</span>}
        {c.authType === 'oauth' && c.pasteLink && <McpPasteLink c={c} signIn={signIn} returnTo={returnTo} />}
        {editing && (
          <>
            <SecretInputs names={names} stored={c.secretNames ?? []} values={values}
              onChange={(n, v) => setValues(s => ({ ...s, [n]: v }))} />
            <div className="inline-form settings-form mcp-submit">
              <button disabled={busy} onClick={saveSecrets}>Save</button>
              <button className="btn-ghost" disabled={busy} onClick={() => { setValues({}); setEditing(false); }}>Cancel</button>
            </div>
          </>
        )}
      </div>
      <div className="mcp-row-actions">
        {!editing && names.length > 0 && <button className="btn-ghost" disabled={busy} onClick={() => setEditing(true)}>Secrets</button>}
        {c.authType === 'oauth' && (
          <button className="btn-ghost" disabled={busy} onClick={link}>{!linked ? 'Link' : choosable ? 'Change permissions' : 'Re-link'}</button>
        )}
        {c.authType === 'oauth' && linked && <button className="btn-ghost" disabled={busy} onClick={unlink}>Unlink</button>}
        <button className="btn-ghost" disabled={busy} onClick={() => setConfirming(true)}>Delete</button>
      </div>
      {confirming && (
        <ConfirmDialog
          message={`Delete ${c.displayName ?? c.name}? Your boxes lose this MCP server at their next delivery, a running session's next call to it is refused, and its ${c.authType === 'oauth' ? 'sign-in is revoked' : 'secrets are deleted'}.`}
          confirmLabel="Delete"
          onConfirm={remove}
          onCancel={() => setConfirming(false)}
        />
      )}
    </li>
  );
}

function AddForm({ initialUpstream, storeAvailable, onLink, onAdded, onReload, onError }: {
  initialUpstream: string | null;
  storeAvailable: boolean;
  onLink: BeginLink;
  onAdded: () => void;
  // Reloads the list and keeps the error banner: a failed sign-in start can
  // follow a create that went through.
  onReload: () => void;
  onError: (failure: Failure) => void;
}) {
  const [upstream, setUpstream] = useState(initialUpstream ?? '');
  const [name, setName] = useState(initialUpstream ? suggestName(initialUpstream) : '');
  const [nameTouched, setNameTouched] = useState(false);
  const [mode, setMode] = useState<'oauth' | 'static'>('oauth');
  const [headerText, setHeaderText] = useState(DEFAULT_HEADERS);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => parseHeaderLines(headerText), [headerText]);
  const names = referencedSecretNames(parsed.headers);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (mode === 'oauth') {
      setBusy(true);
      try {
        const created = await mcpConnectorsApi.create({ name, upstream, auth: { type: 'oauth' } });
        if (await onLink(created)) {
          // The checklist or a new sign-in tab is open over the new connector, which the reload lists under Your servers.
          setUpstream(''); setName(''); setNameTouched(false);
          onReload();
          setBusy(false);
        }
      } catch (err) {
        onError(apiError(err, 'Could not add the connector'));
        onReload();
        setBusy(false);
      }
      return;
    }
    if (parsed.error) { onError({ message: parsed.error }); return; }
    setBusy(true);
    try {
      const secrets = Object.fromEntries(names.filter(n => values[n]).map(n => [n, values[n]]));
      await mcpConnectorsApi.create({ name, upstream, auth: { type: 'static', headers: parsed.headers }, secrets });
      setUpstream(''); setName(''); setNameTouched(false); setHeaderText(DEFAULT_HEADERS); setValues({});
      onAdded();
    } catch (err) {
      onError(apiError(err, 'Could not add the connector'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="mcp-form" onSubmit={add}>
      <div className="mcp-form-title">Add a server</div>
      <label className="inline-form settings-form mcp-field">
        <span>URL</span>
        <input value={upstream} placeholder="https://mcp.example.com/mcp" onChange={e => {
          setUpstream(e.target.value);
          if (!nameTouched) setName(suggestName(e.target.value));
        }} />
      </label>
      <label className="inline-form settings-form mcp-field">
        <span>Name</span>
        <input value={name} placeholder="Example Docs" onChange={e => { setName(e.target.value); setNameTouched(true); }} />
      </label>
      <label className="inline-form settings-form mcp-field">
        <span>Sign-in</span>
        <select value={mode} onChange={e => setMode(e.target.value === 'static' ? 'static' : 'oauth')}>
          <option value="oauth">OAuth</option>
          <option value="static">API key (headers)</option>
        </select>
      </label>
      {mode === 'oauth' ? (
        <>
          <div className="credentials-hint mcp-field-hint">
            You sign in to the server next. termag keeps and refreshes the token; no box holds it.
          </div>
          {!storeAvailable && (
            <div className="credentials-error mcp-field-hint">This orchestrator has no credential store, so it cannot keep a sign-in.</div>
          )}
        </>
      ) : (
        <>
          <label className="inline-form settings-form mcp-field">
            <span>Headers</span>
            <textarea rows={2} value={headerText} spellCheck={false} onChange={e => setHeaderText(e.target.value)} />
          </label>
          <div className="credentials-hint mcp-field-hint">
            One <code>Name: value</code> per line. Write a secret as <code>{'{{secret.<name>}}'}</code>: it is stored
            encrypted and never reaches a box.
          </div>
          <SecretInputs names={names} stored={[]} values={values} onChange={(n, v) => setValues(s => ({ ...s, [n]: v }))} />
          {!storeAvailable && names.length > 0 && (
            <div className="credentials-error mcp-field-hint">This orchestrator has no credential store, so it cannot keep secrets.</div>
          )}
        </>
      )}
      <div className="inline-form settings-form mcp-submit">
        <button type="submit" disabled={busy || !upstream.trim() || !name.trim()}>
          {mode === 'oauth' ? 'Add and sign in' : 'Add server'}
        </button>
      </div>
    </form>
  );
}

/**
 * The user's MCP servers, given to every box they own through the termag MCP
 * broker. Secrets are write-only.
 */
export function McpSection({ focus, search }: { focus: boolean; search: string }) {
  const agents = mcpAgentNames(PROVIDERS);
  const [list, setList] = useState<McpConnectorList | null>(null);
  const [error, setError] = useState<Failure | null>(null);
  const param = useMemo(() => serverParam(search), [search]);
  const result = useMemo(() => linkResult(search), [search]);
  // The localhost sign-in open in another tab, for its connector's paste box,
  // kept across a reload of Settings until its connector links (mcpSignIn.ts).
  const signIn = useMcpSignIn(setError, undefined, result.linked ? param.connectorId : null);
  const { beginLink, pending } = signIn;
  const ref = useRef<HTMLElement>(null);

  const load = () => mcpConnectorsApi.list().then(setList).catch(err => setError(apiError(err, 'Could not load MCP servers')));
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (focus && !param.connectorId) ref.current?.scrollIntoView({ block: 'start' });
  }, [focus, param.connectorId, list === null]);

  return (
    <section ref={ref} className="dash-section" aria-labelledby="mcp-h">
      <div className="dash-section-title" id="mcp-h">
        MCP servers on your boxes
        <DocsLink anchor="mcp-servers" topic="MCP servers on your boxes" />
      </div>
      <div className="dash-card">
        <p className="settings-hint">
          {agents} on every box you own get these servers through the termag broker, which adds your
          credentials to each call. Boxes never hold them.
        </p>
        {result.linked && <div className="settings-notice" role="status">Linked. Your agents can use this MCP now.</div>}
        {result.error && <div className="error-banner" role="alert">{result.error}</div>}
        {error && (
          <div className="error-banner" role="alert">
            <div className="mcp-error-text">
              {error.message}
              {error.callbackUrl && <McpCallbackUrl url={error.callbackUrl} />}
            </div>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}
        {list && !list.available && (
          <div className="settings-notice warn" role="status">No MCP broker is set up on this orchestrator yet, so boxes don't get these servers.</div>
        )}
        {list && !!list.catalog?.length && <div className="mcp-form-title">Your servers</div>}
        {list && (
          <ul className="settings-list mcp-list">
            {list.connectors.length === 0 && <li className="settings-empty">No MCP servers yet.</li>}
            {list.connectors.map(c => (
              <ConnectorRow key={c.id} c={c} focused={c.id === param.connectorId} signIn={pending?.connectorId === c.id ? pending : null} onLink={beginLink} onChanged={() => { setError(null); void load(); }} onError={setError} />
            ))}
          </ul>
        )}
        {list && !!list.catalog?.length && (
          <McpCatalogList catalog={list.catalog} storeAvailable={list.storeAvailable} signIn={signIn} onReload={() => void load()} onError={setError} />
        )}
        {list && (
          <AddForm key={param.upstream ?? ''} initialUpstream={param.upstream} storeAvailable={list.storeAvailable} onLink={beginLink}
            onAdded={() => { setError(null); void load(); }} onReload={() => void load()} onError={setError} />
        )}
        {signIn.scopeDialog}
      </div>
    </section>
  );
}
