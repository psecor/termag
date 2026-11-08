import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { SshKeysSection, SshKeysSectionHandle } from './settings/SshKeysSection';
import { GithubCredential } from './settings/GithubCredential';
import { DotfilesSection } from './settings/DotfilesSection';
import { NewProjectForm } from '../components/NewProjectForm';
import { boxFeed } from '../services/boxFeed';
import { blocksManagedBox, gateArmed } from '../boxGate';
import { credentialsApi, CredentialsStatus, mcpConnectorsApi, McpConnectorList } from '../services/api';
import { recordProductEvent } from '../observability';
import { FLAGS, useFlag } from '../flags';
import WelcomeRefresh from './welcome/WelcomeRefresh';
import { McpStep } from './welcome/McpStep';

/**
 * First-run setup: /welcome. Offered when /auth/me says
 * needsOnboarding (never finished, no projects); reachable any time from
 * Settings. The SSH, GitHub and Dotfiles steps reuse the Settings sections
 * verbatim so there is one implementation of each behaviour, and the MCP
 * servers step reuses Settings → MCP's catalog list (shown only when the
 * catalog offers a server). The last step is the same NewProjectForm the
 * sidebar's New project dialog uses: pick or create a box, wait for it, and
 * create the first project on it, optionally as a clone of a starter repo.
 */

type StepId = 'ssh' | 'github' | 'dotfiles' | 'mcp' | 'project';
const STEPS: Array<{ id: StepId; title: string; blurb: string }> = [
  { id: 'ssh', title: 'Your laptop SSH key', blurb: 'Lets you ssh, scp and port-forward into your boxes. Added to every box you own.' },
  { id: 'github', title: 'GitHub', blurb: 'Paste the output of `gh auth token` from your laptop. The token stays on the orchestrator; your boxes\' git and gh reach GitHub through it, so you never log in to GitHub on a box.' },
  { id: 'dotfiles', title: 'Dotfiles', blurb: 'A repo applied to each new box: shell config, editor settings, the usual.' },
  { id: 'mcp', title: 'MCP servers', blurb: 'Connect a server and the agent on your boxes can use its tools, signed in as you.' },
  { id: 'project', title: 'Your first box and project', blurb: 'A box is a machine of your own that runs your agents; a project is a directory on it with an agent in it. Create a box (a few minutes the first time unless a warm one is waiting) or use one you have, then start from a known repo or your own.' },
];
const OPTIONAL: StepId[] = ['ssh', 'github', 'dotfiles', 'mcp'];

/** The step named by ?step= (the MCP step's sign-ins return to /welcome?step=mcp), else the first. */
export function initialStep(search: string): StepId {
  return new URLSearchParams(search).get('step') === 'mcp' ? 'mcp' : 'ssh';
}

function apiError(err: unknown, fallback: string): string {
  const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
  return typeof msg === 'string' ? msg : fallback;
}

/** /welcome: the redrawn setup under onboarding-refresh-enabled, else the one below. */
export default function Welcome() {
  return useFlag(FLAGS.onboardingRefresh, false) ? <WelcomeRefresh /> : <WelcomeClassic />;
}

function WelcomeClassic() {
  const { user, setOnboarded } = useAuth();
  const navigate = useNavigate();
  const { search } = useLocation();
  const [stepId, setStepId] = useState<StepId>(() => initialStep(search));
  const sshSection = useRef<SshKeysSectionHandle>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    // The top of the onboarding funnel.
    recordProductEvent('welcome.viewed');
    return () => { mounted.current = false; };
  }, []);
  const [sshBusy, setSshBusy] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null);

  // The MCP step shows while onboarding-mcp-step-enabled is on and the catalog
  // (mcp-default-connectors, minus the servers the user has) offers an MCP
  // server; API providers (`kind: 'api'`) alone don't count. Once the catalog
  // has offered one it stays for this visit, so connecting the last one doesn't
  // take the step away; a sign-in's return to ?step=mcp shows it too. With the
  // flag off the wizard neither loads the list nor has the step. A failed load
  // leaves the step out, except on that return, where the step shows the error
  // with Retry.
  const mcpStepOn = useFlag(FLAGS.onboardingMcpStep, false);
  const [mcpList, setMcpList] = useState<McpConnectorList | null>(null);
  const [mcpError, setMcpError] = useState('');
  const [catalogOffered, setCatalogOffered] = useState(stepId === 'mcp');
  // Whether the MCP step has been open: its tab shows done only then, since it
  // can join the list after the person has already moved on to Project.
  const [mcpSeen, setMcpSeen] = useState(stepId === 'mcp');
  const loadMcp = () => {
    setMcpError('');
    return mcpConnectorsApi.list().then(l => {
      if (!mounted.current) return;
      setMcpList(l);
      if (l.catalog?.some(s => s.kind !== 'api')) setCatalogOffered(true);
    }).catch(err => { if (mounted.current) setMcpError(apiError(err, 'Could not load MCP servers')); });
  };
  useEffect(() => { if (mcpStepOn) void loadMcp(); }, [mcpStepOn]);
  useEffect(() => { if (stepId === 'mcp') setMcpSeen(true); }, [stepId]);

  const offerMcp = mcpStepOn && catalogOffered;
  const steps = offerMcp ? STEPS : STEPS.filter(s => s.id !== 'mcp');
  const step = Math.max(0, steps.findIndex(s => s.id === stepId));
  const cur = steps[step];
  const setStep = (i: number) => setStepId(steps[i].id);
  const isDone = (id: StepId, i: number) => i < step && (id !== 'mcp' || mcpSeen);

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
    if (mounted.current) navigate('/', { replace: true });
  }
  async function finishWithoutProject() {
    await setOnboarded(true).catch(() => {});
    if (mounted.current) navigate('/', { replace: true });
  }

  function leaveStep(action: () => void) {
    if (sshSection.current?.busy || pendingNavigation) return;
    if (sshSection.current?.hasDraft) setPendingNavigation(() => action);
    else action();
  }

  function keepEditing() {
    setPendingNavigation(null);
    sshSection.current?.focusDraft();
  }

  async function addAndContinue() {
    if (!pendingNavigation || sshSection.current?.busy) return;
    const proceed = pendingNavigation;
    setPendingNavigation(null);
    const saved = await sshSection.current?.addDraft();
    if (!mounted.current) return;
    if (saved) proceed();
    else sshSection.current?.focusDraft();
  }

  const next = () => leaveStep(() => setStep(Math.min(steps.length - 1, step + 1)));
  const back = () => leaveStep(() => setStep(Math.max(0, step - 1)));

  return (
    <div className="dash-root">
      <div className="dash-page wiz-page">
        <header className="dash-header">
          <h1>Welcome to termag</h1>
          <span className="dash-updated">{user?.email}</span>
          <button className="btn-ghost wiz-skip-all" disabled={sshBusy} onClick={() => leaveStep(() => void skipAll())} title="You can run this again from Settings">Skip setup</button>
        </header>

        <ol className="wiz-steps" aria-label="setup steps">
          {steps.map((s, i) => (
            <li key={s.id} className={`wiz-step${i === step ? ' is-current' : ''}${isDone(s.id, i) ? ' is-done' : ''}`}>
              <button type="button" disabled={sshBusy} onClick={() => { if (i !== step) leaveStep(() => setStep(i)); }}>
                <span className="wiz-step-n">{isDone(s.id, i) ? '✓' : i + 1}</span>
                <span className="wiz-step-t">{s.title}</span>
              </button>
            </li>
          ))}
        </ol>

        <section className="dash-section wiz-body" aria-labelledby="wiz-h">
          <div className="dash-section-title" id="wiz-h"><span>Step {step + 1} of {steps.length}: {cur.title}</span></div>
          <p className="wiz-blurb">{cur.blurb}</p>

          {cur.id === 'ssh' && <SshKeysSection ref={sshSection} onBusyChange={setSshBusy} />}
          {cur.id === 'github' && (
            <div className="dash-card">
              {credStatus
                ? <GithubCredential status={credStatus.github} onChanged={loadCredentials} onError={setCredError} />
                : <div className="usage-dim">Loading…</div>}
              {credError && <div className="credentials-error">{credError}</div>}
            </div>
          )}
          {cur.id === 'dotfiles' && <DotfilesSection />}
          {cur.id === 'mcp' && <McpStep list={mcpList} loadError={mcpError} search={search} onReload={() => void loadMcp()} />}

          {cur.id === 'project' && (
            <div className="dash-card wiz-card">
              <NewProjectForm
                onGithubRequired={() => { void loadCredentials(); setStepId('github'); }}
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
            <button className="btn-ghost" onClick={back} disabled={step === 0 || sshBusy}>← Back</button>
            <span className="usage-dim">{githubArmed ? '' : OPTIONAL.includes(cur.id) ? 'Optional. You can finish it later in Settings.' : ''}</span>
            {cur.id !== 'project'
              ? (githubBlocked ? null : <button className="btn-primary" disabled={sshBusy} onClick={next}>Next</button>)
              : <span />}
          </div>
        </section>
      </div>
      {pendingNavigation && createPortal(
        <div className="confirm-backdrop" onClick={keepEditing}>
          <div
            className="confirm-dialog wiz-ssh-draft-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="unsaved-ssh-key-title"
            tabIndex={-1}
            onClick={e => e.stopPropagation()}
            onKeyDown={e => {
              if (e.key === 'Escape') { e.preventDefault(); keepEditing(); }
              if (e.key === 'Tab') {
                const buttons = e.currentTarget.querySelectorAll('button');
                const first = buttons[0], last = buttons[buttons.length - 1];
                if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
              }
            }}
          >
            <div className="confirm-message" id="unsaved-ssh-key-title">
              You entered an SSH key but haven't added it. Add it before continuing?
            </div>
            <div className="confirm-actions">
              <button className="btn-ghost" onClick={keepEditing} autoFocus>Keep editing</button>
              <button className="btn-ghost" onClick={() => { const proceed = pendingNavigation; setPendingNavigation(null); proceed(); }}>Continue without adding</button>
              <button className="btn-primary" data-analytics="sshkey-add-continue" onClick={() => void addAndContinue()}>Add key and continue</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
