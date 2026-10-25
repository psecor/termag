import React, { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { dotfilesNotice } from './dotfilesNotice';
import { DocsLink } from './DocsLink';

function apiError(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback;
}

export function DotfilesSection() {
  const { user, updateDotfilesRepoUrl } = useAuth();
  const saved = user?.dotfilesRepoUrl ?? '';
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { setDraft(saved); }, [saved]);

  async function save(url: string | null) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await updateDotfilesRepoUrl(url);
      setNotice(dotfilesNotice(url));
    } catch (err) {
      setError(apiError(err, 'Failed to save the dotfiles repository'));
    } finally {
      setBusy(false);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    void save(draft.trim() || null);
  }

  return (
    <section className="dash-section" aria-labelledby="dotfiles-h">
      <div className="dash-section-title" id="dotfiles-h">
        Dotfiles <DocsLink anchor="dotfiles" topic="Dotfiles" />
      </div>
      <div className="dash-card">
        <p className="settings-hint">
          A GitHub repository applied to every box you claim from the warm pool, as GitHub
          Codespaces does: the first of <code>install.sh</code>, <code>install</code>,{' '}
          <code>bootstrap.sh</code>, <code>bootstrap</code>, <code>script/bootstrap</code>,{' '}
          <code>setup.sh</code>, <code>setup</code> or <code>script/setup</code> runs. With none,
          a <a href="https://www.chezmoi.io/" target="_blank" rel="noreferrer">chezmoi</a> source
          directory is applied with <code>chezmoi init --apply</code>, each prompt taking its
          default. Otherwise every top-level file or directory whose name starts with a dot (<code>.zshrc</code>,{' '}
          <code>.gitconfig</code>, <code>.config</code>) is symlinked into your home from the clone
          at <code>~/.dotfiles</code>; a file already there is kept, and anything without a leading
          dot (a README, this list) is left alone. A public repository is cloned when the box is
          claimed. A private one waits until you sign in to GitHub on the box with{' '}
          <code>gh auth login</code> and run <code>termag-hook-run claim</code>, which then applies it. termag never uses a shared GitHub token
          for it.
        </p>
        {error && <div className="error-banner">{error}<button onClick={() => setError('')}>×</button></div>}
        {notice && (
          <div className="settings-notice" role="status">
            {notice}<button onClick={() => setNotice('')}>×</button>
          </div>
        )}
        <form className="inline-form settings-form" onSubmit={submit}>
          <input
            id="dotfiles-repo-url"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder="https://github.com/owner/dotfiles"
            aria-label="Dotfiles repository"
            spellCheck={false}
          />
          <button type="submit" disabled={busy || draft.trim() === saved}>{busy ? 'Saving…' : 'Save'}</button>
          {saved && (
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => { setDraft(''); void save(null); }}>
              Clear
            </button>
          )}
        </form>
      </div>
    </section>
  );
}
