import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, ButtonGroup, Dialog, Disclosure, DisclosurePanel, Heading, Modal, ModalOverlay, Radio, RadioGroup, Text,
} from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { useAuth } from '../../contexts/AuthContext';
import { NewProjectForm } from '../../components/NewProjectForm';
import { boxFeed } from '../../services/boxFeed';
import { blocksManagedBox } from '../../boxGate';
import { credentialsApi, type CredentialsStatus } from '../../services/api';
import { recordProductEvent } from '../../observability';
import { recordUiMode } from '../../chat/uiMode';
import { LP_THEME } from '../../launchpad/theme';
import { ensureLaunchPadSprite } from '../../launchpad/sprite';
import type { SshKeysSectionHandle } from '../settings/SshKeysSection';
import { DotfilesField, GithubField, SshKeyField } from './SetupFields';
import './welcome.css';

/**
 * First-run setup under onboarding-refresh-enabled. Three steps: GitHub, with the SSH key and dotfiles folded into
 * one optional row; how you work, termag (the chat UI, preselected) or Lab
 * (the terminal workspace); and the start. termag ends on the chat UI's New
 * session; Lab keeps the New project form and opens the project in Lab.
 */

export type WorkMode = 'termag' | 'lab';
type StepId = 'github' | 'mode' | 'start';
const STEP_LABELS: Record<StepId, string> = { github: 'GitHub', mode: 'How you work', start: 'Start' };
/** How setup ended: New session, a Lab project (or a branch-off of one), or Skip for now. */
type SetupExit = 'session' | 'project' | 'branch-off' | 'skip';

export default function WelcomeRefresh() {
  const { user, setOnboarded } = useAuth();
  const navigate = useNavigate();
  const steps: StepId[] = ['github', 'mode', 'start'];
  const [step, setStep] = useState<StepId>('github');
  const at = steps.indexOf(step);
  const [chosen, setMode] = useState<WorkMode>('termag');
  const mode: WorkMode = chosen;
  // Continue waits for this: until it answers, nobody knows whether GitHub is
  // required, and a failed check is retried rather than skipped past.
  const [cred, setCred] = useState<CredentialsStatus | null>(null);
  const [credFailed, setCredFailed] = useState(false);
  const loadCred = () => credentialsApi.get()
    .then(c => { setCred(c); setCredFailed(false); })
    .catch(() => setCredFailed(true));
  const ssh = useRef<SshKeysSectionHandle>(null);
  const [sshBusy, setSshBusy] = useState(false);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    // The funnel's top: a first run, or a visit from Settings.
    recordProductEvent('welcome.viewed', { 'termag.refresh': true, 'termag.firstRun': !!user?.needsOnboarding });
    void ensureLaunchPadSprite();
    void loadCred();
    return () => { mounted.current = false; };
  }, []);
  // The project form reads boxes from the shared feed, which MainLayout runs
  // on the workspace route; this page is outside it, so it runs the feed.
  useEffect(() => {
    if (!user) return;
    boxFeed.start();
    return () => boxFeed.stop();
  }, [user]);

  useEffect(() => {
    recordProductEvent('welcome.step', { 'termag.step': step });
  }, [step]);

  const githubBlocked = blocksManagedBox(cred?.github.boxGate);
  const githubConnected = !!(cred?.github.available && cred.github.connected);

  // Every exit awaits the flag before navigating: FirstRunGate reads
  // needsOnboarding and would bounce straight back. The choice of termag or
  // Lab is where each later visit opens (chat/uiMode.ts).
  async function finish(to: string, as: WorkMode = mode, exit: SetupExit = 'session') {
    recordProductEvent('welcome.finished', { 'termag.mode': as, 'termag.exit': exit, 'termag.step': step });
    await setOnboarded(true).catch(() => {});
    if (!mounted.current) return;
    recordUiMode(as === 'lab' ? 'full' : 'simple');
    navigate(to, { replace: true });
  }
  const skip = () => void finish(mode === 'lab' ? '/' : '/chat', mode, 'skip');

  // Leaving the first step with a key typed but not added asks first, as the
  // wizard on main does (#371); a save in flight blocks leaving.
  function leave(action: () => void) {
    if (ssh.current?.busy || pending) return;
    if (ssh.current?.hasDraft) setPending(() => action);
    else action();
  }
  function keepEditing() {
    setPending(null);
    ssh.current?.focusDraft();
  }
  async function addAndContinue() {
    if (!pending || ssh.current?.busy) return;
    const proceed = pending;
    setPending(null);
    const ok = await ssh.current?.addDraft();
    if (!mounted.current) return;
    if (ok) proceed();
    else ssh.current?.focusDraft();
  }

  return (
    <div className={`wel-root ${LP_THEME}`}>
      <header className="wel-top">
        <span className="wel-brand"><Icon name="terminal" size="medium" aria-hidden="true" />termag</span>
        <Button variant="minimal" isDisabled={sshBusy} onPress={() => leave(skip)}>Skip for now</Button>
      </header>

      <main className="wel-card" aria-labelledby="wel-h">
        <ol className="wel-progress" aria-label="Setup steps">
          {steps.map((id, i) => (
            <li key={id} className={i < at ? 'is-done' : i === at ? 'is-current' : ''} aria-current={i === at ? 'step' : undefined}>
              <span className="wel-progress-bar" />
              <span className="wel-progress-label">{STEP_LABELS[id]}</span>
            </li>
          ))}
        </ol>

        {step === 'github' && (
          <>
            <StepHead title="Connect GitHub" sub="Your boxes use this token for git and gh, so you never sign in to GitHub on a box." />
            <GithubField status={cred?.github ?? null} onChanged={loadCred} />
            <Disclosure className="wel-extras">
              {({ isExpanded }) => (
                <>
                  <Button slot="trigger" variant="minimal" className="wel-extras-trigger">
                    <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size="medium" aria-hidden="true" />
                    <span>SSH key and dotfiles</span>
                    <span className="wel-optional">Optional</span>
                  </Button>
                  <DisclosurePanel className="wel-extras-panel">
                    <SshKeyField ref={ssh} onBusyChange={setSshBusy} />
                    <DotfilesField />
                    <Text className="wel-dim">Both can wait. They&apos;re in Settings whenever you want them.</Text>
                  </DisclosurePanel>
                </>
              )}
            </Disclosure>
            <footer className="wel-foot">
              {credFailed
                ? <span className="wel-foot-note">Couldn&apos;t check your GitHub connection. <Button variant="minimal" size="small" onPress={() => void loadCred()}>Retry</Button></span>
                : githubBlocked
                  ? <Text className="wel-foot-note">Connect GitHub to continue. termag needs it to set up your boxes.</Text>
                  : <span />}
              <Button variant={githubConnected ? 'primary' : 'default'} size="large" isDisabled={!cred || githubBlocked || sshBusy} onPress={() => leave(() => setStep('mode'))}>
                Continue
              </Button>
            </footer>
          </>
        )}

        {step === 'mode' && (
          <>
            <StepHead title="How do you want to work?" sub="You can switch any time from your account menu." />
            <RadioGroup aria-label="How you work" value={chosen} onChange={v => setMode(v as WorkMode)} className="wel-modes">
              <Radio value="termag" className="wel-mode">
                <ModeArt kind="termag" />
                <span className="wel-mode-text">
                  <span className="wel-mode-name">termag <span className="wel-badge">Recommended</span><ModeCheck /></span>
                  <span className="wel-mode-blurb">Chat with your agents. Open a terminal, files or a browser beside the chat when you need one.</span>
                </span>
              </Radio>
              <Radio value="lab" className="wel-mode">
                <ModeArt kind="lab" />
                <span className="wel-mode-text">
                  <span className="wel-mode-name"><Icon name="flask" size="medium" aria-hidden="true" />Lab<ModeCheck /></span>
                  <span className="wel-mode-blurb">The terminal-first workspace. New features land here first, so it moves fast and can be rough.</span>
                </span>
              </Radio>
            </RadioGroup>
            <footer className="wel-foot">
              <Button variant="minimal" onPress={() => setStep('github')}>Back</Button>
              <Button variant="primary" size="large" onPress={() => { recordProductEvent('welcome.mode.chosen', { 'termag.mode': mode }); setStep('start'); }}>Continue</Button>
            </footer>
          </>
        )}

        {step === 'start' && mode === 'termag' && (
          <>
            <StepHead title="You're ready" sub="Start a session: pick a repository and tell the agent what to do." />
            <ol className="wel-next">
              <li><Icon name="folders" size="medium" aria-hidden="true" /><span>Pick a repository</span></li>
              <li><Icon name="chat-bubble-outline" size="medium" aria-hidden="true" /><span>Say what you want done</span></li>
              <li><Icon name="rocket" size="medium" aria-hidden="true" /><span>termag starts a box and the agent</span></li>
            </ol>
            <footer className="wel-foot">
              <Button variant="minimal" onPress={() => setStep('mode')}>Back</Button>
              <Button variant="primary" size="large" onPress={() => void finish('/chat/new')}>Start a session</Button>
            </footer>
          </>
        )}

        {step === 'start' && mode === 'lab' && (
          <>
            <StepHead title="Start your first project" sub="It opens in Lab once its box is up." />
            <div className="wel-form">
              <NewProjectForm
                onGithubRequired={() => { void loadCred(); setStep('github'); }}
                submitLabel="Create project"
                quiet
                actions={<Button variant="minimal" onPress={() => setStep('mode')}>Back</Button>}
                onBranchOff={projectId => void finish(`/?project=${encodeURIComponent(projectId)}&branchOff=1`, 'lab', 'branch-off')}
                onCreated={project => finish(`/?project=${encodeURIComponent(project.id)}`, 'lab', 'project')}
              />
            </div>
          </>
        )}
      </main>

      {pending && (
        <ModalOverlay isOpen isDismissable onOpenChange={open => { if (!open) keepEditing(); }} className={`wel-layer ${LP_THEME}`}>
          <Modal size="medium" className="wel-confirm">
            <Dialog role="alertdialog" className="wel-confirm-dialog">
              <Heading slot="title" level={2} className="wel-confirm-title">Add the SSH key you entered?</Heading>
              <Text elementType="p" slot="subtitle" className="wel-sub">You typed a key but haven&apos;t added it yet.</Text>
              <ButtonGroup className="wel-confirm-buttons">
                <Button variant="minimal" onPress={keepEditing}>Keep editing</Button>
                <Button variant="minimal" onPress={() => { const proceed = pending; setPending(null); proceed(); }}>Continue without it</Button>
                <Button variant="primary" autoFocus data-analytics="sshkey-add-continue" onPress={() => void addAndContinue()}>Add key and continue</Button>
              </ButtonGroup>
            </Dialog>
          </Modal>
        </ModalOverlay>
      )}
    </div>
  );
}

function StepHead({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="wel-head">
      <Heading level={1} id="wel-h" className="wel-title">{title}</Heading>
      <Text className="wel-sub">{sub}</Text>
    </div>
  );
}

/** Shown on the selected card (CSS); the radio input carries the state for assistive tech. */
function ModeCheck() {
  return <span className="wel-mode-check" aria-hidden="true"><Icon name="check-circle" size="medium" /></span>;
}

/** A small drawing of each way of working: chat bubbles, or terminal panes. */
function ModeArt({ kind }: { kind: WorkMode }) {
  return (
    <span className={`wel-art wel-art-${kind}`} aria-hidden="true">
      <span className="wel-art-side"><i /><i /><i /></span>
      {kind === 'termag' ? (
        <span className="wel-art-main">
          <span className="wel-art-bubble is-you" />
          <span className="wel-art-bubble" />
          <span className="wel-art-bubble is-short" />
          <span className="wel-art-composer" />
        </span>
      ) : (
        <span className="wel-art-main wel-art-panes">
          <span className="wel-art-pane"><i /><i /><i /><i className="is-caret" /></span>
          <span className="wel-art-pane"><i /><i /><i className="is-caret" /></span>
        </span>
      )}
    </span>
  );
}
