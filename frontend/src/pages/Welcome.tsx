import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { SshKeysSection } from './settings/SshKeysSection';
import { GithubCredential } from './settings/GithubCredential';
import { DotfilesSection } from './settings/DotfilesSection';
import { NewProjectForm } from '../components/NewProjectForm';
import { boxFeed } from '../services/boxFeed';
import { blocksManagedBox, gateArmed } from '../boxGate';
import { credentialsApi, CredentialsStatus } from '../services/api';

/**
 * First-run setup: /welcome. Offered when /auth/me says
 * needsOnboarding (never finished, no projects); reachable any time from
 * Settings. Steps 1–3 reuse the Settings sections verbatim so there is one
 * implementation of each behaviour; step 4 is the same NewProjectForm the
 * sidebar's New project dialog uses: pick or create a box, wait for it, and
 * create the first project on it, optionally as a clone of a starter repo.
 */

type StepId = 'ssh' | 'github' | 'dotfiles' | 'project';
const STEPS: Array<{ id: StepId; title: string; blurb: string }> = [
  { id: 'ssh', title: 'Your laptop SSH key', blurb: 'Lets you ssh, scp and port-forward into your boxes. Added to every box you own.' },
  { id: 'github', title: 'GitHub', blurb: 'Paste the output of `gh auth token` from your laptop. The token stays on the orchestrator; your boxes\' git and gh reach GitHub through it, so you never log in to GitHub on a box.' },
  { id: 'dotfiles', title: 'Dotfiles', blurb: 'A repo applied to each new box: shell config, editor settings, the usual.' },
  { id: 'project', title: 'Your first box and project', blurb: 'A box is a machine of your own that runs your agents; a project is a directory on it with an agent in it. Create a box (a few minutes the first time unless a warm one is waiting) or use one you have, then start from a known repo or your own.' },
];
const OPTIONAL: StepId[] = ['ssh', 'github', 'dotfiles'];

function apiError(err: unknown, fallback: string): string {
  const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
  return typeof msg === 'string' ? msg : fallback;
}

export default function Welcome() {
  const { user, setOnboarded } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const cur = STEPS[step];
  const githubStep = STEPS.findIndex(s => s.id === 'github');

  // Adding a managed box needs a stored GitHub token (boxGate): with the gate
  // armed the GitHub step is not optional, and while blocked it has no Next.
  const [credStatus, setCredStatus] = useState<CredentialsStatus | null>(null);
  const [credError, setCredError] = useState('');
  const loadCredentials = () => credentialsApi.get().then(setCredStatus).catch(err => setCredError(apiError(err, 'Could not load credentials')));
  useEffect(() => { void loadCredentials(); }, []);
  const githubGate = credStatus?.github.boxGate;
  const githubArmed = cur.id === 'github' && gateArmed(githubGate);
  const githubBlocked = cur.id === 'github' && blocksManagedBox(githubGate);

  // The form reads boxes from the shared feed, which MainLayout owns on the
  // workspace route; this page is outside that layout, so it runs the feed
  // itself while mounted.
  useEffect(() => {
    if (!user) return;
    boxFeed.start();
    return () => boxFeed.stop();
  }, [user]);

  // Both exits await the flag before navigating: FirstRunGate reads
  // needsOnboarding on the workspace route and would bounce straight back.
  async function skipAll() {
    await setOnboarded(true).catch(() => {});
    navigate('/', { replace: true });
  }
  async function finishWithoutProject() {
    await setOnboarded(true).catch(() => {});
    navigate('/', { replace: true });
  }

  const next = () => setStep(s => Math.min(STEPS.length - 1, s + 1));
  const back = () => setStep(s => Math.max(0, s - 1));

  return (
    <div className="dash-root">
      <div className="dash-page wiz-page">
        <header className="dash-header">
          <h1>Welcome to termag</h1>
          <span className="dash-updated">{user?.email}</span>
          <button className="btn-ghost wiz-skip-all" onClick={() => void skipAll()} title="You can run this again from Settings">Skip setup</button>
        </header>

        <ol className="wiz-steps" aria-label="setup steps">
          {STEPS.map((s, i) => (
            <li key={s.id} className={`wiz-step${i === step ? ' is-current' : ''}${i < step ? ' is-done' : ''}`}>
              <button type="button" onClick={() => setStep(i)}>
                <span className="wiz-step-n">{i < step ? '✓' : i + 1}</span>
                <span className="wiz-step-t">{s.title}</span>
              </button>
            </li>
          ))}
        </ol>

        <section className="dash-section wiz-body" aria-labelledby="wiz-h">
          <div className="dash-section-title" id="wiz-h"><span>Step {step + 1} of {STEPS.length} — {cur.title}</span></div>
          <p className="wiz-blurb">{cur.blurb}</p>

          {cur.id === 'ssh' && <SshKeysSection />}
          {cur.id === 'github' && (
            <div className="dash-card">
              {credStatus
                ? <GithubCredential status={credStatus.github} onChanged={loadCredentials} onError={setCredError} />
                : <div className="usage-dim">Loading…</div>}
              {credError && <div className="credentials-error">{credError}</div>}
            </div>
          )}
          {cur.id === 'dotfiles' && <DotfilesSection />}

          {cur.id === 'project' && (
            <div className="dash-card wiz-card">
              <NewProjectForm
                onGithubRequired={() => { void loadCredentials(); setStep(githubStep); }}
                submitLabel="Create project and open it"
                actions={<button type="button" className="btn-ghost" onClick={() => void finishWithoutProject()}>Finish without a project</button>}
                onBranchOff={projectId => {
                  void (async () => {
                    await setOnboarded(true).catch(() => {});
                    navigate(`/?project=${encodeURIComponent(projectId)}&branchOff=1`, { replace: true });
                  })();
                }}
                onCreated={async project => {
                  await setOnboarded(true).catch(() => {});
                  navigate(`/?project=${encodeURIComponent(project.id)}`, { replace: true });
                }}
              />
            </div>
          )}

          <div className="wiz-nav">
            <button className="btn-ghost" onClick={back} disabled={step === 0}>← Back</button>
            <span className="usage-dim">{githubArmed ? '' : OPTIONAL.includes(cur.id) ? 'Optional — finish it later in Settings.' : ''}</span>
            {cur.id !== 'project'
              ? (githubBlocked ? null : <button className="btn-primary" onClick={next}>Next</button>)
              : <span />}
          </div>
        </section>
      </div>
    </div>
  );
}
