import { useState } from 'react';

/**
 * termag's OAuth callback URL with a Copy button, under the Settings → MCP
 * servers error that says a server refused termag's redirect URI: the URL an
 * admin allow-lists there ("When a server refuses the
 * redirect"). Built from the settings page's own code and ghost button, as the
 * rest of the section is.
 */
/** Copy for a URL, and the button's label (Copy, Copied, Copy failed); shared with the setup wizard. */
export function useCopyUrl(url: string): { copy: () => Promise<void>; label: string } {
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied('yes');
    } catch {
      setCopied('failed');
    }
    setTimeout(() => setCopied(null), 2000);
  }
  return { copy, label: copied === 'yes' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy' };
}

export function McpCallbackUrl({ url }: { url: string }) {
  const { copy, label } = useCopyUrl(url);

  return (
    <div className="mcp-callback">
      <code>{url}</code>
      <button type="button" className="btn-ghost" onClick={() => void copy()}>
        {label}
      </button>
    </div>
  );
}
