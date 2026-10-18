// New chat in the simple UI: pick a repository, say what you want, Start.
// Every chat gets its own new box (the server claims a warm one when the pool
// has one, else launches one) and Claude; the first message waits in the
// chat until Claude can take it (chat/newChat.ts).
import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useProjects } from '../../contexts/ProjectContext';
import { credentialsApi, instancesApi, projectsApi } from '../../services/api';
import { blocksManagedBox, type BoxGateState } from '../../boxGate';
import { boxFeed } from '../../services/boxFeed';
import { noteAddBoxClick, noteBoxClaimed, noteProjectCreated } from '../../services/claimTiming';
import { replaySessionId } from '../../observability';
import { RepoPicker } from '../../components/RepoPicker';
import { BOX_NAME_ERROR, isValidBoxName } from '../../utils/boxNames';
import { funnyProjectName, isBoxFailedRefusal } from '../../utils/projectStart';
import { createBody, suggestedName, type RepoPick } from '../../utils/repoPick';
import { chatHref } from '../../chat/simpleChat';
import { newChatNames, writeQueued } from '../../chat/newChat';
import { CHAT_PROVIDER_ID } from '../../providers/registry';
import { MAX_KEYS } from '../../chat/compose';
import type { Instance } from '../../types';

const PROJECT_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function apiError(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;
}

export function NewChat() {
  const navigate = useNavigate();
  const { projects, reloadProjects } = useProjects();
  const boxes = useSyncExternalStore(boxFeed.subscribe, boxFeed.getSnapshot);

  const [pick, setPick] = useState<RepoPick>({ kind: 'empty' });
  const [message, setMessage] = useState('');
  const [fallbackName] = useState(() => funnyProjectName());
  const defaults = useMemo(
    () => newChatNames(suggestedName(pick) ?? fallbackName, projects.map(p => p.name), boxes.map(b => b.name)),
    [pick, fallbackName, projects, boxes],
  );
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  const [boxEdit, setBoxEdit] = useState<string | null>(null);
  const name = (nameEdit ?? defaults.projectName).trim();
  const boxName = (boxEdit ?? defaults.boxName).trim();

  const [gate, setGate] = useState<BoxGateState | undefined>();
  useEffect(() => {
    let cancelled = false;
    credentialsApi.get().then(c => { if (!cancelled) setGate(c.github.boxGate); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const blocked = blocksManagedBox(gate);

  // A box launched for an attempt whose project was then refused is reused
  // by the retry, so a second Start never launches a second box.
  const [launched, setLaunched] = useState<Instance | null>(null);
  const [busy, setBusy] = useState<'box' | 'chat' | null>(null);
  const [error, setError] = useState('');

  const body = createBody(pick);
  const nameError = name && !PROJECT_NAME_RE.test(name) ? 'Letters, digits, - and _ only' : '';
  const boxError = !launched && boxName && !isValidBoxName(boxName) ? BOX_NAME_ERROR : '';
  const canStart = !busy && !blocked && body !== null && !!name && !nameError && (!!launched || (!!boxName && !boxError));

  async function start(e: React.FormEvent) {
    e.preventDefault();
    if (!canStart || !body) return;
    setError('');
    let box = launched;
    if (!box) {
      setBusy('box');
      noteAddBoxClick();
      try {
        const r = await instancesApi.create(boxName, 'ec2');
        if (r.claimed) noteBoxClaimed(r.instance.id);
        boxFeed.upsert(r.instance);
        box = r.instance;
        setLaunched(box);
      } catch (err) {
        const code = (err as { response?: { data?: { code?: string } } })?.response?.data?.code;
        if (code === 'github-required') setGate('blocked');
        else setError(apiError(err, 'Could not launch a box'));
        setBusy(null);
        return;
      }
    }
    setBusy('chat');
    try {
      const project = await projectsApi.create({
        name,
        instanceId: box.id,
        initialAgent: { enabled: true, provider: CHAT_PROVIDER_ID },
        replaySessionId: await replaySessionId(),
        ...body,
      });
      noteProjectCreated(project.id, box.id);
      const held = !message.trim() || writeQueued(typeof localStorage !== 'undefined' ? localStorage : null, project.id, message);
      await reloadProjects().catch(() => {});
      // Storage would not queue it: hand it to the chat's composer instead.
      navigate(chatHref(project.id, 'main'), held ? undefined : { state: { draft: message } });
    } catch (err) {
      if (isBoxFailedRefusal(err)) {
        setLaunched(null);
        await boxFeed.reload();
        setError('The box failed to launch. Start again to launch another.');
      } else {
        setError(apiError(err, 'Could not start the chat'));
      }
      setBusy(null);
    }
  }

  if (blocked) {
    return (
      <div className="chat-new-page">
        <div className="chat-new-card">
          <h2>Connect GitHub first</h2>
          <p>Every chat runs on its own box, and termag needs your GitHub token to launch one and check your repository out there.</p>
          <Link className="btn-primary" to="/settings">Connect GitHub in Settings</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-new-page">
      <form className="chat-new-card" onSubmit={e => void start(e)}>
        <h2>New chat</h2>
        <p className="chat-new-lede">Pick a repository and say what you want. termag launches a box for this chat, checks the repository out and starts Claude.</p>
        <RepoPicker value={pick} onChange={next => { setPick(next); setNameEdit(null); setBoxEdit(null); }} />
        <label className="chat-new-field">
          <span>First message</span>
          <textarea
            className="chat-input"
            value={message}
            onChange={e => setMessage(e.target.value.slice(0, MAX_KEYS))}
            placeholder="What should Claude do? It is sent as soon as Claude is up."
            rows={4}
          />
        </label>
        <details className="chat-new-options">
          <summary>Options</summary>
          <label className="chat-new-field">
            <span>Chat name</span>
            <input value={nameEdit ?? defaults.projectName} onChange={e => setNameEdit(e.target.value)} />
            {nameError && <span className="chat-new-error">{nameError}</span>}
          </label>
          <label className="chat-new-field">
            <span>Box name</span>
            <input value={launched ? launched.name : boxEdit ?? defaults.boxName} disabled={!!launched} onChange={e => setBoxEdit(e.target.value)} />
            {boxError && <span className="chat-new-error">{boxError}</span>}
          </label>
        </details>
        {error && <div className="chat-new-error" role="alert">{error}</div>}
        <div className="chat-new-actions">
          <Link className="btn-ghost" to="/chat">Cancel</Link>
          <button type="submit" className="btn-primary" disabled={!canStart}>
            {busy === 'box' ? 'Launching a box…' : busy === 'chat' ? 'Starting…' : 'Start'}
          </button>
        </div>
      </form>
    </div>
  );
}
