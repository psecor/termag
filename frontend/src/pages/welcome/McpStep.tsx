import { useMemo, useState } from 'react';
import type { McpConnectorList } from '../../services/api';
import { ConnectorRow } from '../settings/McpSection';
import { McpCatalogList, useMcpSignIn, type Failure } from '../settings/McpCatalog';
import { McpCallbackUrl } from '../settings/McpCallbackUrl';
import { linkResult, serverParam } from '../settings/mcpForm';

/**
 * The setup wizard's MCP servers step: Settings → MCP's
 * "Available to connect" list and the rows of the servers already connected,
 * without the Add a server form. Its sign-ins return to /welcome?step=mcp
 * (returnTo 'welcome'), which reopens the wizard here with `server` and
 * `linked` or `error` in the query, read as Settings reads them.
 */
export function McpStep({ list, loadError, search, onReload }: {
  // GET /api/mcp-connectors, loaded by the wizard, which also decides whether this step shows.
  list: McpConnectorList | null;
  // Why that load failed, if it did; Retry loads it again.
  loadError: string;
  search: string;
  onReload: () => void;
}) {
  const [error, setError] = useState<Failure | null>(null);
  const param = useMemo(() => serverParam(search), [search]);
  const result = useMemo(() => linkResult(search), [search]);
  const signIn = useMcpSignIn(setError, 'welcome', result.linked ? param.connectorId : null);
  const linkedName = result.linked ? list?.connectors.find(c => c.id === param.connectorId)?.name : undefined;

  if (!list) {
    return (
      <div className="dash-card">
        {loadError
          ? <div className="error-banner" role="alert">{loadError}<button onClick={onReload}>Retry</button></div>
          : <div className="usage-dim">Loading…</div>}
      </div>
    );
  }
  return (
    <div className="dash-card">
      {result.linked && (
        <div className="settings-notice" role="status">
          {linkedName ? `${linkedName} is connected.` : 'Connected.'}{list.available ? ' Your agents can use it now.' : ''}
        </div>
      )}
      {!list.available && (
        <div className="settings-notice warn" role="status">No MCP broker is set up on this orchestrator yet, so boxes don't get these servers.</div>
      )}
      {result.error && <div className="error-banner" role="alert">{result.error}</div>}
      {loadError && <div className="error-banner" role="alert">{loadError}<button onClick={onReload}>Retry</button></div>}
      {error && (
        <div className="error-banner" role="alert">
          <div className="mcp-error-text">
            {error.message}
            {error.callbackUrl && <McpCallbackUrl url={error.callbackUrl} />}
          </div>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}
      {list.connectors.length > 0 && (
        <>
          <div className="mcp-form-title">Your servers</div>
          <ul className="settings-list mcp-list" aria-label="Your servers">
            {list.connectors.map(c => (
              <ConnectorRow key={c.id} c={c} focused={c.id === param.connectorId} returnTo="welcome"
                signIn={signIn.pending?.connectorId === c.id ? signIn.pending : null} onLink={signIn.beginLink}
                onChanged={() => { setError(null); onReload(); }} onError={setError} />
            ))}
          </ul>
        </>
      )}
      {!!list.catalog?.length && (
        <McpCatalogList catalog={list.catalog} storeAvailable={list.storeAvailable} signIn={signIn} onReload={onReload} onError={setError} />
      )}
      {signIn.scopeDialog}
    </div>
  );
}
