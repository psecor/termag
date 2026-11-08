import { useState, type ReactNode } from 'react';
import { mcpConnectorsApi, McpCatalogServer, McpConnector, McpReturnTo } from '../../services/api';
import { Dialog } from '../../components/Dialog';
import { clearPendingSignIn, loadPendingSignIn, openSignIn, savePendingSignIn, type PendingSignIn } from './mcpSignIn';
import { initialScopes } from './mcpForm';

/**
 * The MCP catalog's "Available to connect" list and the sign-in it starts,
 * shared by Settings → MCP (McpSection.tsx) and the setup wizard's MCP step
 * (pages/welcome/McpStep.tsx). The wizard passes returnTo 'welcome', so the
 * sign-in's callback brings the browser back to the wizard.
 */

// A server's display name. For an MCP server its title names the tool prefix
// agents see, so the connector name can be found on hover when no line under
// the name shows it. An API provider (`kind: 'api'`) is never an MCP server on
// the box, so its name has no title.
export function ServerName({ display, name, kind }: { display: string; name: string; kind?: string }) {
  return <span className="settings-row-name" title={kind === 'api' ? undefined : `In tool names: mcp__${name}__…`}>{display}</span>;
}

// The connector name in small text under the display name, only when the two differ.
export function ConnectorNameLine({ display, name }: { display: string; name: string }) {
  return display === name ? null : <span className="settings-row-mono mcp-row-connector-name">{name}</span>;
}

// An error for the page's banner. callbackUrl is set when the server
// refused termag's redirect URI: the URL an admin allow-lists, shown with Copy.
export type Failure = { message: string; callbackUrl?: string };

export function apiError(err: unknown, fallback: string): Failure {
  const data = (err as { response?: { data?: { error?: unknown; redirectUri?: unknown } } })?.response?.data;
  return {
    message: typeof data?.error === 'string' ? data.error : fallback,
    ...(typeof data?.redirectUri === 'string' ? { callbackUrl: data.redirectUri } : {}),
  };
}

// Starts a sign-in for an OAuth connector: the scope checklist first when its
// server offers a choice, else straight to the server's sign-in page. Answers
// true when the page stays open (the checklist, or a sign-in in a new tab), so
// the caller frees its button.
export type BeginLink = (c: McpConnector) => Promise<boolean>;

// Sends the browser to a connector's sign-in (mcpSignIn.ts openSignIn).
// Answers true when the page stays open: a localhost sign-in, in a new tab.
export type SignIn = (connectorId: string, authorizeUrl: string) => boolean;

// Asks the server for a connector's sign-in URL, for `scopes` (all when undefined).
type StartOAuth = (connectorId: string, scopes: string[] | undefined) => Promise<string>;

/** One page's sign-ins: the scope checklist, and the localhost sign-in open in another tab. */
export interface McpSignIn {
  signIn: SignIn;
  beginLink: BeginLink;
  // Opens the scope checklist for a connector.
  choose: (c: McpConnector) => void;
  // The localhost sign-in open in another tab, for its connector's paste box.
  pending: PendingSignIn | null;
  // The open scope checklist, for the page to render.
  scopeDialog: ReactNode;
  returnTo: McpReturnTo | undefined;
}

// linkedConnectorId: the connector the page's `?server=…&linked=1` says just
// linked, whose kept sign-in is done with.
export function useMcpSignIn(onError: (failure: Failure) => void, returnTo?: McpReturnTo, linkedConnectorId?: string | null): McpSignIn {
  const [choosing, setChoosing] = useState<McpConnector | null>(null);
  // Kept across a reload of the page until its connector links (mcpSignIn.ts).
  const [pending, setPending] = useState<PendingSignIn | null>(() => {
    const kept = loadPendingSignIn();
    if (kept && linkedConnectorId && kept.connectorId === linkedConnectorId) {
      clearPendingSignIn();
      return null;
    }
    return kept;
  });
  const start: StartOAuth = (id, scopes) =>
    (returnTo ? mcpConnectorsApi.startOAuth(id, scopes, returnTo) : mcpConnectorsApi.startOAuth(id, scopes));

  const signIn: SignIn = (connectorId, authorizeUrl) => {
    const how = openSignIn(authorizeUrl);
    if (how === 'navigated') return false;
    const p = { connectorId, authorizeUrl, blocked: how === 'blocked' };
    savePendingSignIn(p);
    setPending(p);
    return true;
  };

  const beginLink: BeginLink = async c => {
    if (c.oauth?.scopeChoice) {
      setChoosing(c);
      return true;
    }
    return signIn(c.id, await start(c.id, undefined));
  };

  const scopeDialog = choosing
    ? <ScopeDialog c={choosing} start={start} onSignIn={signIn} onCancel={() => setChoosing(null)} onError={onError} />
    : null;
  return { signIn, beginLink, choose: setChoosing, pending, scopeDialog, returnTo };
}

/**
 * The scopes a sign-in asks for, chosen before the redirect: some servers'
 * consent screens (Slack's) grant everything asked for or nothing. Built from
 * the settings page's own Dialog, buttons and checkboxes.
 */
function ScopeDialog({ c, start, onSignIn, onCancel, onError }: {
  c: McpConnector;
  start: StartOAuth;
  onSignIn: SignIn;
  onCancel: () => void;
  onError: (failure: Failure) => void;
}) {
  const oauth = c.oauth!;
  const options = oauth.scopeChoice?.options ?? [];
  const [selected, setSelected] = useState<string[]>(() => initialScopes(oauth, c.linkStatus === 'linked'));
  const [busy, setBusy] = useState(false);
  const toggle = (name: string) => setSelected(s => (s.includes(name) ? s.filter(x => x !== name) : [...s, name]));

  async function signIn() {
    setBusy(true);
    try {
      // In the server's order, which is the order the authorize URL lists them.
      const url = await start(c.id, options.map(o => o.name).filter(n => selected.includes(n)));
      if (onSignIn(c.id, url)) onCancel();
    } catch (err) {
      onError(apiError(err, 'Could not start signing in to the server'));
      onCancel();
    }
  }

  return (
    <Dialog title={`What may agents do in ${c.displayName ?? c.name}?`} onClose={onCancel} closeDisabled={busy} className="np-dialog mcp-scope-dialog">
      <p className="settings-hint">
        termag asks the server for only what you tick. Your agents can then do only these things, on every box.
      </p>
      <div className="inline-form settings-form mcp-scope-actions">
        <button type="button" className="btn-ghost" disabled={busy || selected.length === options.length}
          onClick={() => setSelected(options.map(o => o.name))}>Select all</button>
        <button type="button" className="btn-ghost" disabled={busy || selected.length === 0} onClick={() => setSelected([])}>Clear</button>
      </div>
      {/* The scopes scroll on their own; Select all / Clear above and the buttons below stay in view. */}
      <fieldset className="scroll-list mcp-scope-list" aria-label="Scopes" disabled={busy}>
        {options.map(o => (
          <label key={o.name} className="briefing-schedule-row mcp-scope-row">
            <input type="checkbox" value={o.name} checked={selected.includes(o.name)} onChange={() => toggle(o.name)} />
            <span>{o.label}</span>
            {o.label !== o.name && <code className="mcp-scope-name">{o.name}</code>}
          </label>
        ))}
      </fieldset>
      <div className="confirm-actions">
        <button className="confirm-btn confirm-btn-cancel" disabled={busy} onClick={onCancel}>Cancel</button>
        <button className="confirm-btn confirm-btn-primary" disabled={busy || selected.length === 0} onClick={signIn}>Continue to sign in</button>
      </div>
    </Dialog>
  );
}

/**
 * A server the orchestrator offers that the user hasn't connected yet.
 * Connect creates their connector for it and sends them to the server's
 * sign-in page; after that it shows under their own servers instead.
 */
function CatalogRow({ server, storeAvailable, returnTo, onSignIn, onChoose, onReload, onError }: {
  server: McpCatalogServer;
  storeAvailable: boolean;
  returnTo: McpReturnTo | undefined;
  onSignIn: SignIn;
  // Opens the scope checklist for the connector Connect made.
  onChoose: (c: McpConnector) => void;
  // Reloads the list and keeps the error banner.
  onReload: () => void;
  onError: (failure: Failure) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function connect() {
    setBusy(true);
    try {
      const { authorizeUrl, connector } = await mcpConnectorsApi.connectCatalog(server.name, { chooseScopes: true, ...(returnTo ? { returnTo } : {}) });
      if (authorizeUrl) {
        // A sign-in in a new tab leaves the page here; the reload moves the
        // server to Your servers, where its paste box is.
        if (onSignIn(connector.id, authorizeUrl)) {
          onReload();
          setBusy(false);
        }
        return;
      }
      // The server offers a choice of scopes. Connect made the connector, so
      // the reload lists it under Your servers while the checklist is open.
      // Connect is enabled again, for when that reload fails and this row stays.
      onReload();
      onChoose(connector);
      setBusy(false);
    } catch (err) {
      onError(apiError(err, 'Could not connect the server'));
      // Connect can create the connector and then fail to start sign-in; the
      // reload moves the server to Your servers (not authed, with Link) rather
      // than leaving it offered here.
      onReload();
      setBusy(false);
    }
  }

  return (
    <li className="settings-row mcp-row">
      <div className="settings-row-text">
        <ServerName display={server.label ?? server.name} name={server.name} kind={server.kind} />
        <ConnectorNameLine display={server.label ?? server.name} name={server.name} />
        <span className="settings-row-mono">{server.upstream}</span>
        {server.kind === 'api' && <span className="settings-row-meta">REST API for a CLI (not an MCP server)</span>}
      </div>
      <div className="mcp-row-actions">
        <button className="btn-ghost" disabled={busy || !storeAvailable} onClick={connect}>Connect</button>
      </div>
    </li>
  );
}

/** The catalog servers the user has no connector for yet, each with Connect. */
export function McpCatalogList({ catalog, storeAvailable, signIn, onReload, onError }: {
  catalog: McpCatalogServer[];
  storeAvailable: boolean;
  signIn: McpSignIn;
  onReload: () => void;
  onError: (failure: Failure) => void;
}) {
  return (
    <>
      <div className="mcp-form-title">Available to connect</div>
      <ul className="settings-list mcp-list" aria-label="Available to connect">
        {catalog.map(s => (
          <CatalogRow key={s.name} server={s} storeAvailable={storeAvailable} returnTo={signIn.returnTo} onSignIn={signIn.signIn}
            onChoose={signIn.choose} onReload={onReload} onError={onError} />
        ))}
      </ul>
    </>
  );
}
