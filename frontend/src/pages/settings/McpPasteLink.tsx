import { useEffect, useRef, useState } from 'react';
import { mcpConnectorsApi, McpConnector, McpReturnTo } from '../../services/api';
import type { PendingSignIn } from './mcpSignIn';

export type { PendingSignIn };

/**
 * The paste box for a server on the user's mcp-oauth-loopback-servers list.
 * Link opens the server's
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

  const form = (
    <form className="mcp-form mcp-paste" method="post" action={mcpConnectorsApi.pasteLinkAction(c.id)}>
      {/* The answer returns to the setup wizard rather than Settings when the sign-in started there. */}
      {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
      {signIn?.blocked && (
        <div className="credentials-error mcp-field-hint mcp-paste-fallback">
          Your browser blocked the new tab.{' '}
          <a href={signIn.authorizeUrl} target="_blank" rel="noopener noreferrer">Open the sign-in page</a>
        </div>
      )}
      <div className="credentials-hint mcp-field-hint">
        Sign in in the new tab. When it lands on a page that won't load, copy that page's address, close the tab and paste
        it here.
      </div>
      <label className="inline-form settings-form mcp-field">
        <span>Address</span>
        <input ref={input} name="url" value={url} autoComplete="off" spellCheck={false} placeholder="http://localhost:53682/callback?…"
          onChange={e => setUrl(e.target.value)} />
      </label>
      <div className="inline-form settings-form mcp-submit">
        <button type="submit" disabled={!url.trim()}>Finish linking</button>
      </div>
    </form>
  );
  return c.linkStatus !== 'linked' || signIn ? form : null;
}
