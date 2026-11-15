// Settings → My files, under project-files-enabled: the person's
// own files for what's personal or reusable across projects. "Put My files on my boxes" is a LaunchPad Switch, on
// by default; off removes My files' box grants and nothing grants it again until it's back on, and the files stay
// (PUT /auth/me/preferences { myFilesOnBoxes }). "Use an existing space as My files…" makes a space they own their
// My files ({ myFilesSpace }); the one it replaces is kept.
import React, { useState } from 'react';
import { Button, Switch } from '@launchpad-ui/components';
import { useAuth } from '../../contexts/AuthContext';
import { FLAGS, useFlag } from '../../flags';
import { LP_THEME } from '../../launchpad/theme';
import { UseSpaceDialog } from '../chat/UseSpaceDialog';

export function MyFilesSection() {
  const { user, updatePreferences } = useAuth();
  const projectFiles = useFlag(FLAGS.projectFiles, false);
  const userProjects = useFlag(FLAGS.userProjects, false);
  const on = projectFiles && userProjects;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [choosing, setChoosing] = useState(false);
  // Sent only while project-files-enabled is on for them: absent, the server's flag is off.
  if (!on || user?.myFilesOnBoxes === undefined) return null;
  const onBoxes = user.myFilesOnBoxes !== false;
  const space = user.myFilesSpace ?? null;
  const save = async (next: boolean) => {
    setBusy(true); setError('');
    try { await updatePreferences({ myFilesOnBoxes: next }); } catch { setError('Could not save that.'); } finally { setBusy(false); }
  };
  return (
    <section className="dash-section" id="my-files" aria-labelledby="my-files-h">
      <div className="dash-section-title" id="my-files-h">My files</div>
      <div className="dash-card">
        <p className="settings-hint">
          Your own files, for what's personal or useful across projects. Each project has its own Project files, where
          agents save what they make for it; they save here only what's personal or reusable, or when you ask
          (<code>termag space put --mine</code>). Both are in the side panel's Files.
        </p>
        {error && <div className="error-banner">{error}<button onClick={() => setError('')}>×</button></div>}
        <div className={`settings-form ${LP_THEME} settings-my-files`}>
          <Switch isSelected={onBoxes} isDisabled={busy} onChange={next => { void save(next); }} className="settings-my-files-switch">
            Put My files on my boxes
          </Switch>
          <p className="settings-hint" role="status">
            {onBoxes
              ? 'On: every box you own can reach My files, so your sessions there can save to it and read it.'
              : "Off: no box reaches My files. Its files stay, and you can still open them in Files."}
          </p>
          <div className="settings-my-files-space">
            <span className="settings-hint">{space ? <>My files is <code>{space}</code>.</> : 'My files is made the first time you open it.'}</span>
            <Button variant="default" size="small" onPress={() => setChoosing(true)}>Use an existing space as My files…</Button>
          </div>
        </div>
      </div>
      {choosing && (
        <UseSpaceDialog
          title="Use an existing space as My files"
          note="One you own that isn't a project's files. The My files it replaces keeps its files."
          current={space}
          onUse={async name => { await updatePreferences({ myFilesSpace: name }); }}
          onClose={() => setChoosing(false)}
        />
      )}
    </section>
  );
}
