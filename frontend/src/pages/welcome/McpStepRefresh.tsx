import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert, Button, ButtonGroup, Checkbox, CheckboxGroup, Dialog, Form, Heading, Input, Label, Link, Modal, ModalOverlay, Text, TextField,
} from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import type { McpCatalogServer, McpConnector, McpConnectorList } from '../../services/api';
import { LP_THEME } from '../../launchpad/theme';
import { connectCatalogServer, useMcpSignIn, useScopeChecklist, type Failure, type ScopeChecklistProps } from '../settings/McpCatalog';
import { startLink } from '../settings/McpSection';
import { PASTE_HINT, PASTE_PLACEHOLDER, PASTE_SUBMIT, pasteLinkForm, pasteLinkShown, type PendingSignIn } from '../settings/McpPasteLink';
import { useCopyUrl } from '../settings/McpCallbackUrl';
import { connectAction, connectorStatus, linkResult, serverParam } from '../settings/mcpForm';

/**
 * The redrawn setup's MCP servers step,
 * in LaunchPad: the catalog's servers with Connect, in the catalog's order, and
 * the servers already connected. Every sign-in is Settings → MCP's own
 * flow, drawn here in LaunchPad: Connect (connectCatalogServer, startLink,
 * connectAction's label), the scope checklist (useScopeChecklist), the
 * localhost paste box (pasteLinkShown, pasteLinkForm), errors with the
 * callback URL to copy (useCopyUrl), and Change permissions. Sign-ins are
 * sent with returnTo 'welcome', so they come back to
 * /welcome?step=mcp&server=<id>&linked=1 (or &error=), read here as Settings
 * reads it. Secrets, Unlink and Delete stay in Settings.
 */

function serverLabel(name: string, label?: string | null): string {
  return label ?? name;
}

function host(upstream: string): string {
  try { return new URL(upstream).host; } catch { return upstream; }
}

// Ready as Settings → MCP's status says (connectorStatus): an OAuth server signed
// in, or a static one whose secrets are all set and readable.
const isReady = (c: McpConnector) => connectorStatus(c).tone === 'good';

/** A connector agents can use as an MCP server now: ready, and not an API provider (`kind: 'api'`). */
export function usableMcpServer(c: McpConnector): boolean {
  return c.kind !== 'api' && isReady(c);
}

export function McpStepRefresh({ list, loadError, search, onReload }: {
  // GET /api/mcp-connectors, loaded by the wizard, which also decides whether this step shows.
  list: McpConnectorList | null;
  // Why that load failed, if it did; Retry loads it again.
  loadError: string;
  search: string;
  onReload: () => void;
}) {
  const navigate = useNavigate();
  const [error, setError] = useState<Failure | null>(null);
  const param = useMemo(() => serverParam(search), [search]);
  const result = useMemo(() => linkResult(search), [search]);
  const signIn = useMcpSignIn(setError, 'welcome', result.linked ? param.connectorId : null);
  const [busy, setBusy] = useState<string | null>(null);

  if (!list) {
    return loadError
      ? <Alert status="error" variant="inline">{loadError} <Button variant="minimal" size="small" onPress={onReload}>Retry</Button></Alert>
      : <Text className="wel-dim">Loading…</Text>;
  }

  const returned = param.connectorId ? list.connectors.find(c => c.id === param.connectorId) : undefined;
  const connectors = list.connectors;
  const catalog = list.catalog ?? [];

  async function connect(server: McpCatalogServer) {
    setBusy(server.name);
    setError(null);
    const leaving = await connectCatalogServer(server, 'welcome', signIn.signIn, signIn.choose, onReload, setError);
    if (!leaving) setBusy(null);
  }
  const link = (c: McpConnector) => startLink(c, signIn.beginLink, b => setBusy(b ? c.id : null), f => { setError(f); });

  return (
    <div className="wel-tools">
      {result.linked && (
        <Alert status="success" variant="inline">{returned ? `${serverLabel(returned.name, returned.displayName)} is connected.` : 'Connected.'}</Alert>
      )}
      {result.error && (
        <Alert status="error" variant="inline">
          {result.error}
          {returned && returned.authType === 'oauth' && (
            <> <Button variant="minimal" size="small" isDisabled={busy === returned.id} onPress={() => { setError(null); void link(returned); }}>Retry</Button></>
          )}
        </Alert>
      )}
      {!list.available && (
        <Alert status="warning" variant="inline">This orchestrator has no MCP broker, so boxes don&apos;t get these servers.</Alert>
      )}
      {loadError && (
        <Alert status="error" variant="inline">{loadError} <Button variant="minimal" size="small" onPress={onReload}>Retry</Button></Alert>
      )}
      {error && (
        <Alert status="error" variant="inline" isDismissable onDismiss={() => setError(null)}>
          {error.message}
          {error.callbackUrl && <CallbackUrl url={error.callbackUrl} />}
        </Alert>
      )}

      <ul className="wel-tool-list" aria-label="MCP servers">
        {connectors.map(c => {
          const pending = signIn.pending?.connectorId === c.id ? signIn.pending : null;
          const ready = isReady(c);
          const press = () => { setError(null); void link(c); };
          return (
            <ToolRow key={c.id} name={serverLabel(c.name, c.displayName)} upstream={c.upstream}
              below={(
                <>
                  {c.blocked && <Text className="wel-tool-error">{c.blocked}</Text>}
                  {!c.blocked && c.authType === 'oauth' && !ready && c.linkError && <Text className="wel-tool-error">{c.linkError}</Text>}
                  {!c.blocked && pasteLinkShown(c, pending) && <PasteLink c={c} signIn={pending} />}
                </>
              )}>
              {ready && <span className="wel-tool-status"><Icon name="check-circle" size="medium" className="wel-ok" aria-hidden="true" />Connected</span>}
              {ready && c.authType === 'oauth' && c.oauth?.scopeChoice && (
                <Button variant="minimal" isPending={busy === c.id} onPress={press}>{connectAction(c)}</Button>
              )}
              {!ready && !c.blocked && c.authType === 'static' && (
                <Button onPress={() => navigate(`/settings/mcp?server=${encodeURIComponent(c.id)}`)}>Finish in Settings</Button>
              )}
              {!ready && !c.blocked && c.authType === 'oauth' && (
                <Button isPending={busy === c.id} isDisabled={!list.storeAvailable} onPress={press}>{connectAction(c)}</Button>
              )}
            </ToolRow>
          );
        })}
        {catalog.map(s => (
          <ToolRow key={s.name} name={serverLabel(s.name, s.label)} upstream={s.upstream}>
            <Button isPending={busy === s.name}
              isDisabled={!list.storeAvailable || (!!busy && busy !== s.name)} onPress={() => void connect(s)}>Connect</Button>
          </ToolRow>
        ))}
      </ul>
      {signIn.choosing && (
        <ScopeChecklist key={signIn.choosing.id} c={signIn.choosing} start={signIn.start} onSignIn={signIn.signIn}
          onCancel={signIn.closeChoice} onError={setError} />
      )}
    </div>
  );
}

function ToolRow({ name, upstream, badge, below, children }: { name: string; upstream: string; badge?: ReactNode; below?: ReactNode; children: ReactNode }) {
  return (
    <li className="wel-tool">
      <div className="wel-tool-main">
        <span className="wel-tool-mark" aria-hidden="true"><Icon name="plug" size="medium" /></span>
        <span className="wel-connected-text">
          <span className="wel-tool-name">{name}{badge}</span>
          <span className="wel-dim"><code>{host(upstream)}</code></span>
        </span>
        {children}
      </div>
      {below}
    </li>
  );
}

/** termag's callback URL with Copy, under an error that says the server refused it (Settings' McpCallbackUrl). */
function CallbackUrl({ url }: { url: string }) {
  const { copy, label } = useCopyUrl(url);
  return (
    <span className="wel-callback"><code>{url}</code><Button variant="minimal" size="small" onPress={() => void copy()}>{label}</Button></span>
  );
}

/**
 * Settings' paste box (McpPasteLink.tsx) in LaunchPad: the localhost address
 * the new tab ends on, posted as Settings posts it, so the answer returns here.
 */
function PasteLink({ c, signIn }: { c: McpConnector; signIn: PendingSignIn | null }) {
  const [url, setUrl] = useState('');
  const input = useRef<HTMLInputElement>(null);
  // A server not linked yet shows the box before Connect: each localhost
  // sign-in that starts here moves to it, as Settings' box does.
  useEffect(() => {
    if (!signIn) return;
    input.current?.scrollIntoView({ block: 'center' });
    input.current?.focus();
  }, [signIn]);
  const { action, hidden } = pasteLinkForm(c, 'welcome');
  return (
    <Form className="wel-paste" method="post" action={action}>
      {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {signIn?.blocked && (
        <Text className="wel-dim">Your browser blocked the new tab. <Link href={signIn.authorizeUrl} target="_blank" rel="noopener noreferrer">Open the sign-in page</Link></Text>
      )}
      <div className="wel-inline-form">
        <TextField name="url" value={url} onChange={setUrl} className="wel-field">
          <Label>Address</Label>
          <Input ref={input} placeholder={PASTE_PLACEHOLDER} autoComplete="off" spellCheck={false} />
          <Text slot="description">{PASTE_HINT}</Text>
        </TextField>
        <Button type="submit" isDisabled={!url.trim()}>{PASTE_SUBMIT}</Button>
      </div>
    </Form>
  );
}

/** Settings' scope checklist (useScopeChecklist) in a LaunchPad dialog. */
function ScopeChecklist(props: ScopeChecklistProps) {
  const { c, onCancel } = props;
  const { options, selected, setSelected, busy, signIn } = useScopeChecklist(props);
  return (
    <ModalOverlay isOpen isDismissable={!busy} onOpenChange={open => { if (!open) onCancel(); }} className={`wel-layer ${LP_THEME}`}>
      <Modal size="medium" className="wel-confirm">
        <Dialog className="wel-confirm-dialog">
          <Heading slot="title" level={2} className="wel-confirm-title">What may agents do in {serverLabel(c.name, c.displayName)}?</Heading>
          <CheckboxGroup aria-label="Scopes" value={selected} onChange={setSelected} isDisabled={busy} className="wel-scopes">
            {options.map(o => <Checkbox key={o.name} value={o.name}>{o.label}</Checkbox>)}
          </CheckboxGroup>
          <ButtonGroup className="wel-confirm-buttons">
            <Button variant="minimal" isDisabled={busy || selected.length === options.length} onPress={() => setSelected(options.map(o => o.name))}>Select all</Button>
            <Button variant="minimal" isDisabled={busy || selected.length === 0} onPress={() => setSelected([])}>Clear</Button>
            <Button variant="minimal" isDisabled={busy} onPress={onCancel}>Cancel</Button>
            <Button variant="primary" isPending={busy} isDisabled={selected.length === 0} onPress={() => void signIn()}>Continue</Button>
          </ButtonGroup>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
