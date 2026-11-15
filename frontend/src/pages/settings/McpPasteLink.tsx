import { useEffect, useRef, useState } from 'react';
import { mcpConnectorsApi, McpConnector, McpReturnTo } from '../../services/api';
import type { PendingSignIn } from './mcpSignIn';

export type { PendingSignIn };

/**
 * The paste box's parts, shared by Settings' box below and the setup wizard's
 * (pages/welcome/McpStepRefresh.tsx): when it shows, its one line of help, the
 * field's placeholder, and the post that finishes the sign-in.
 */
export const PASTE_HINT = 'Sign in in the new tab, then paste the address of the page it ends on.';
export const PASTE_PLACEHOLDER = 'http://localhost:53682/callback?…';
export const PASTE_SUBMIT = 'Finish';
/** A server not linked yet, or one whose re-link started here is waiting for the paste. */
export function pasteLinkShown(c: McpConnector, signIn: PendingSignIn | null): boolean {
  return c.authType === 'oauth' && !!c.pasteLink && (c.linkStatus !== 'linked' || !!signIn);
}
/** The form's action and hidden fields: the answer returns to `returnTo` (the wizard), else Settings. */
export function pasteLinkForm(c: McpConnector, returnTo?: McpReturnTo): { action: string; hidden: Record<string, string> } {
  return { action: mcpConnectorsApi.pasteLinkAction(c.id), hidden: returnTo ? { returnTo } : {} };
}

/**
 * The paste box for a server on the user's mcp-oauth-loopback-servers list.
 * Link opens the server's.
 * Connect opens the server's
 * sign-in in a new tab (mcpSignIn.ts); that tab ends on a localhost page that
 * doesn't load, and the person pastes its address here. When the browser
 * blocks the tab, the box shows a plain link to the sign-in page, opening in a
 * new tab. The form is a plain post: the orchestrator answers with the same
 * redirect as a sign-in callback (to Settings, or the setup wizard), so the result shows in the
 * section's usual linked notice or error banner. Built from the settings
 * page's own form, input, link and button classes, as the Add a server form
 * is. A linked server shows the box only while a re-link started here is
 * waiting for the paste.
 */
export function McpPasteLink({ c, signIn, returnTo }: { c: McpConnector; signIn: PendingSignIn | null; returnTo?: McpReturnTo }) {
  const [url, setUrl] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (signIn) input.current?.scrollIntoView({ block: 'center' });
  }, [signIn]);

  if (!pasteLinkShown(c, signIn)) return null;
  const { action, hidden } = pasteLinkForm(c, returnTo);
  return (
    <form className="mcp-form mcp-paste" method="post" action={action}>
      {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {signIn?.blocked && (
        <div className="credentials-error mcp-field-hint mcp-paste-fallback">
          Your browser blocked the new tab.{' '}
          <a href={signIn.authorizeUrl} target="_blank" rel="noopener noreferrer">Open the sign-in page</a>
        </div>
      )}
      <div className="credentials-hint mcp-field-hint">{PASTE_HINT}</div>
      <label className="inline-form settings-form mcp-field">
        <span>Address</span>
        <input ref={input} name="url" value={url} autoComplete="off" spellCheck={false} placeholder={PASTE_PLACEHOLDER}
          onChange={e => setUrl(e.target.value)} />
      </label>
      <div className="inline-form settings-form mcp-submit">
        <button type="submit" disabled={!url.trim()}>{PASTE_SUBMIT}</button>
      </div>
    </form>
  );
}
