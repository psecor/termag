// The agent composer under a space file: tell
// one of the space's agents to do something ("mark 755 ready") without going
// back to its conversation. It is the conversation's own composer
// (SdkComposer on useSdkChat, the same state and behaviour: images,
// dictation, model and effort, the context ring, Stop, trust and sign-in
// notes) for one of the space's sessions. Nothing gets a row of its own, and
// the composer never prints the session's name (an agent's name can be long):
// the placeholder is generic ("Message an agent about this file…"), and a
// small agent button at the start of the composer's bar ("To: <session>" in
// its tooltip and label) opens the picker of the space's sessions (chat/fileChat.ts says which is
// the default). The target is chosen once when the file view opens, and
// changes only when the person picks another; each target is its own
// composer instance, so a send still in flight finishes for the session it
// went to. The message carries a line with the file's space:path. Above the
// box is one fixed-height line (chat/fileStrip.ts fileLine) in place of the
// composer's status line: what became of the message sent from here (sending,
// queued, working, "termag-5 replied: <first line>", a failure with Retry),
// else the session's own status, plus "2 not sent · Show" and a failure in
// another of the space's sessions, with Open for the conversation, where the
// full reply lives. It never grows. The composer sits in the column under the
// file, never over it.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useProjects } from '../../contexts/ProjectContext';
import { chatLiveKey } from '../../chat/chatLiveStatus';
import {
  countSent, defaultFileChatTarget, fileChatMessage, fileChatTargetKey, filledDraft, noteLastChat,
  canComposeIn, onComposeFill, readLastChat, requestComposeFill, useComposeListening, type FileChatTarget,
} from '../../chat/fileChat';
import { groupOpenItems, itemHref, itemKey } from '../../chat/openItems';
import { chatHomeSpace } from '../../chat/chatSpaces';
import { awayFailure, dispatchStrip, fileLine, stripModelOf, stripState, useStripModel, useStripsVersion } from '../../chat/fileStrip';
import { chatRowName, isSdkChat, sidebarLine } from '../../chat/simpleChat';
import { agentLabel } from '../../chat/explorerAgents';
import { ComposeLinkContext } from '../../chat/Markdown';
import { Button, Dialog, DialogTrigger, Menu, MenuItem, MenuTrigger, Popover, Tooltip, TooltipTrigger } from '@launchpad-ui/components';
import '@launchpad-ui/tokens/index.css';
import type { Project } from '../../types';
import { AgentIcon } from './OpenItems';
import { useSimpleDataIfAny } from './simpleData';
import { SdkComposer } from './SdkComposer';
import { UnsentMessages } from './TranscriptNotices';
import { MAX_TEXT, useSdkChat } from './useSdkChat';
import './fileChat.css';

/**
 * Whether this file's composer and Do it links are live: the person an
 * owner or editor of the file's space (chat/fileChat.ts
 * canComposeIn). Not for a viewer, nor for someone viewing a file shared from
 * a space they aren't in. Nothing until the spaces have loaded.
 */
function useComposesIn(space: string): boolean {
  const spaces = useSimpleDataIfAny()?.spaces;
  return spaces?.loaded === true && canComposeIn(spaces.spaces, space);
}

/** The composer under a space file, for its members who may send (useComposesIn); otherwise nothing. Keyed by space, so its reply stays while you move between the space's files. */
export function SpaceFileChat({ space, path }: { space: string; path: string }) {
  return useComposesIn(space) ? <FileChat key={space} space={space} path={path} /> : null;
}

/**
 * The file's own markdown, where `termag-compose:` links fill the composer
 * (for the same people). Otherwise they are their labels as plain text. A reply
 * in the strip gets no such links: only the file the person opened does.
 */
export function FileComposeLinks({ space, children }: { space: string; children: React.ReactNode }) {
  const allowed = useComposesIn(space);
  // Only while this space's composer is mounted to take the text (none with no session in the space).
  const listening = useComposeListening(space);
  const fill = useCallback((text: string) => requestComposeFill(space, text), [space]);
  return allowed && listening ? <ComposeLinkContext.Provider value={fill}>{children}</ComposeLinkContext.Provider> : <>{children}</>;
}

/** `name` is Claude's title when the sidebar leads with one, `where` the project (and workstream), as on the sidebar's row. */
interface Target extends FileChatTarget { tab: string; glyph: string; state: string; where: string; titled: boolean }

const fullName = (t: Target) => (t.titled ? `${t.name} · ${t.where}` : t.name);

export function FileChat({ space, path }: { space: string; path: string }) {
  const data = useSimpleDataIfAny();
  const { projects } = useProjects();
  const byKey = useMemo(() => new Map((data?.rows ?? []).map(r => [itemKey({ kind: 'chat', projectId: r.projectId, workstream: r.workstream }), r])), [data?.rows]);

  // The space's agent sessions that take a message here, in the sidebar's order.
  const targets = useMemo<Target[]>(() => {
    if (!data?.spaces.loaded) return [];
    const { items, spaces, live, setupOf } = data;
    // A chat is in its own space's group (chat/chatSpaces.ts chatHomeSpace), as the sidebar shows it.
    const spaceOf = (c: Parameters<typeof itemKey>[0]) => {
      const row = byKey.get(itemKey(c));
      return row ? chatHomeSpace(row, spaces.spaces, spaces.index) : undefined;
    };
    const group = groupOpenItems(items.state.items, spaces.spaces.map(s => s.name), spaceOf)
      .find(g => g.space === space);
    const seen = new Set<string>();
    const out: Target[] = [];
    for (const item of group?.items ?? []) {
      if (item.kind !== 'chat') continue;
      const k = itemKey(item);
      const row = byKey.get(k);
      const project = projects.find(p => p.id === item.projectId);
      if (seen.has(k) || !row || !project || !isSdkChat(project, item.workstream)) continue;
      seen.add(k);
      const named = chatRowName(row);
      // The project (and workstream), whatever the row puts under its title.
      const where = agentLabel(row);
      const line = sidebarLine(row, live.get(chatLiveKey(row.projectId, row.workstream)), setupOf.get(row.projectId));
      const updated = row.updatedAt ? Date.parse(row.updatedAt) : NaN;
      out.push({
        projectId: item.projectId, workstream: item.workstream, name: named.title ?? where, order: out.length,
        activeAt: Number.isFinite(updated) ? Math.max(updated, item.openedAt) : item.openedAt,
        tab: item.id, glyph: line.glyph, state: line.state, where, titled: named.title != null,
      });
    }
    return out;
  }, [data, byKey, projects, space]);

  // Chosen once, when the view first has sessions, and kept: activity elsewhere
  // (a status write, a tab access) never moves it. Only a pick changes it, or
  // its session going away.
  const [pinned, setPinned] = useState<string | null>(null);
  let target = targets.find(t => fileChatTargetKey(t) === pinned) ?? null;
  if (!target && targets.length) {
    target = defaultFileChatTarget(targets, readLastChat()) as Target;
    setPinned(fileChatTargetKey(target));
  }
  const targetKey = target ? fileChatTargetKey(target) : null;
  const choose = (t: Target) => { noteLastChat(t); setPinned(fileChatTargetKey(t)); };
  const project = target ? projects.find(p => p.id === target.projectId) ?? null : null;

  // The agent the message goes to: a small button at the start of the
  // composer's bar (LaunchPad's Button in a MenuTrigger; its IconButton draws
  // only sprite icons, which termag doesn't load, so the robot is inline).
  const agentPicker = target && (
    <MenuTrigger>
      <TooltipTrigger delay={500}>
        <Button variant="minimal" size="small" className="fv-chat-agent" aria-label={`To: ${fullName(target)}`}>
          <AgentIcon status={target.glyph} />
          <span className="chat-compose-caret" aria-hidden="true" />
        </Button>
        <Tooltip className="fv-lp">To: {fullName(target)}</Tooltip>
      </TooltipTrigger>
      <Popover className="fv-lp" placement="top start">
        <Menu aria-label={`Send to (${space})`} onAction={id => { const t = targets.find(x => fileChatTargetKey(x) === id); if (t) choose(t); }}>
          {targets.map(t => (
            <MenuItem key={fileChatTargetKey(t)} id={fileChatTargetKey(t)} textValue={fullName(t)}>
              {`${fileChatTargetKey(t) === targetKey ? '✓ ' : ''}${fullName(t)} · ${t.state}`}
            </MenuItem>
          ))}
        </Menu>
      </Popover>
    </MenuTrigger>
  );

  // A send to another of the space's sessions that failed after the person
  // picked this one: on the one line, with a way back to it, until seen there.
  useStripsVersion();
  const away = targets
    .filter(t => fileChatTargetKey(t) !== targetKey)
    .map(t => ({ t, failure: awayFailure(stripModelOf(fileChatTargetKey(t))) }))
    .filter((x): x is { t: Target; failure: { error: string } } => x.failure != null)
    .map(({ t, failure }) => ({ key: fileChatTargetKey(t), name: t.name, error: failure.error, go: () => choose(t) }));

  return (
    <>
      {target && project
        ? <FileChatSession key={targetKey} target={target} project={project} space={space} path={path} agentPicker={agentPicker} away={away} />
        : (
          // No session in the space takes a message: a box that says so, and nothing to send.
          <div className="chat-bottom fv-chat">
            <form className="chat-composer" onSubmit={e => e.preventDefault()}>
              <textarea className="chat-input" rows={1} disabled aria-label="Message an agent" placeholder={`No agent session in ${space} to message`} />
            </form>
            <div className="chat-composer-notes" />
          </div>
        )}
    </>
  );
}

type AwayFailure = { key: string; name: string; error: string; go: () => void };

/** The conversation's composer for one target, under the file, with its one line. Keyed by target. */
function FileChatSession({ target, project, space, path, agentPicker, away }: {
  target: Target; project: Project; space: string; path: string; agentPicker: React.ReactNode; away: AwayFailure[];
}) {
  const key = fileChatTargetKey(target);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const follow = useRef<() => void>(() => {});
  const s = useSdkChat(project, target.workstream, follow, {
    decorate: typed => fileChatMessage(typed, space, path),
    // Into this target's strip even when the person has picked another
    // meanwhile (this instance is gone then): the message is this session's.
    onSend: e => {
      if (e.phase === 'sending') dispatchStrip(key, { type: 'sending', text: e.message, occurrence: e.occurrence });
      else if (e.phase === 'queued') dispatchStrip(key, { type: 'queued', text: e.message });
      // On screen, the composer puts the text back and says why; gone (another
      // target picked meanwhile), the session's strip and box take it.
      else if (e.phase === 'unsent') dispatchStrip(key, mounted.current ? { type: 'unsent' } : { type: 'unsent', away: { error: e.error, typed: e.typed, images: e.images } });
      else dispatchStrip(key, { type: e.phase });
      if ((e.phase === 'sending' || e.phase === 'queued') && mounted.current) {
        // Talking to it makes it the one this tab came from.
        noteLastChat(target);
      }
    },
    autoFocus: false,
    escapeAnywhere: false,
    // Gone (another target picked), a failure must not write this session's
    // draft: the strip keeps the text, and the box takes it back when shown.
    keepsFailed: () => mounted.current,
  });
  const { chat, history, setText, composer, unsent, setUnsent, sendUnsent, canSend, dragging, dropHandlers, sendsLive, queued, queueError, retryQueued, status } = s;

  // The pre-ready queue as it is now, with how many bubbles carry its text once the history is in.
  const queueCount = queued != null && history === 'ok' ? countSent(chat, queued) : null;
  useEffect(() => {
    dispatchStrip(key, { type: 'queue', text: s.queuedText, error: queueError, count: queueCount });
  }, [key, queued, queueError, queueCount]);
  const model = useStripModel(key);
  const strip = stripState(model, chat);

  // A link in the file fills the box, focused and in view, for the person to read, edit and send.
  const textNow = useRef(s.text);
  textNow.current = s.text;
  const lastFill = useRef<string | null>(null);
  useEffect(() => onComposeFill(space, fill => {
    const { draft, replaced } = filledDraft(textNow.current, lastFill.current, fill);
    const next = draft.slice(0, MAX_TEXT);
    lastFill.current = replaced ? next : null;
    setText(next);
    requestAnimationFrame(() => {
      const el = composer.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.setSelectionRange(next.length, next.length);
      el.scrollIntoView?.({ block: 'nearest' });
    });
  }), [space, composer, setText]);
  useEffect(() => { if (!s.text) lastFill.current = null; }, [s.text]);

  // Sends that failed after this session's composer was gone: their texts come
  // back into this box, each once and in the order sent, after whatever the
  // box holds (the draft the person kept typing here), and the strip shows the
  // failure, so the note above stops. The strip's list is the only copy (the
  // gone composer left the draft alone), so nothing here can repeat a text.
  const restoredFrom = useRef<readonly string[] | null>(null);
  useEffect(() => {
    const back = model.restore;
    if (!back.length || restoredFrom.current === back) return;
    restoredFrom.current = back;
    const cur = textNow.current.trimEnd();
    setText([cur, ...back].filter(Boolean).join('\n').slice(0, MAX_TEXT));
    dispatchStrip(key, { type: 'restored' });
  }, [model.restore, key, setText]);
  useEffect(() => { if (awayFailure(model)) dispatchStrip(key, { type: 'seen' }); }, [model, key]);

  const retry = () => { dispatchStrip(key, { type: 'retry' }); retryQueued(); };
  const line = fileLine(strip, { name: target.name, status, running: chat.running, live: sendsLive, unsent: unsent.length, away });
  const awayGo = line.away ? away.find(a => a.key === line.away!.key) : undefined;

  // One line, fixed height, in the status line's place. Nothing here grows:
  // the reply itself is in the conversation (Open).
  const statusLine = (
    <div className="fv-chat-line" data-tone={line.tone} data-strip={strip.kind} role="status" aria-live="polite">
      {line.spinner && <span className="sdk-spinner" aria-hidden="true" />}
      {/* The agent's name is cut first (about 16 characters, the full name on hover), so the status and Open stay in view. */}
      <span className="fv-chat-line-text">
        <span className="fv-chat-line-name" title={fullName(target)}>{line.name}</span>
        <span className="fv-chat-line-status" title={line.text}>{line.status}</span>
      </span>
      {line.retry && <Button variant="minimal" size="small" className="fv-chat-line-btn chat-queued-retry" onPress={retry}>Retry</Button>}
      {line.unsent > 0 && (
        <DialogTrigger>
          <Button variant="minimal" size="small" className="fv-chat-line-btn fv-chat-unsent">{line.unsent} not sent · Show</Button>
          <Popover className="fv-lp fv-chat-unsent-pop" placement="top end">
            <Dialog aria-label="Not sent">
              {/* What Stop took back before it went, as in the conversation's transcript. */}
              <UnsentMessages texts={unsent} disabled={!canSend} onSend={sendUnsent} onDiscard={i => setUnsent(u => u.filter((_, j) => j !== i))} />
            </Dialog>
          </Popover>
        </DialogTrigger>
      )}
      {line.away && awayGo && (
        <Button variant="minimal" size="small" className="fv-chat-line-btn fv-chat-away" aria-label={`Not sent to ${line.away.name}: ${line.away.error}. Its text is back in its box. Go to ${line.away.name}`}
          data-tip={`Not sent to ${line.away.name}: ${line.away.error}`}
          onPress={awayGo.go}>
          {/* The name is in the label and tooltip only: an agent's name can be long. */}
          {`Not sent${line.awayMore ? ` (${line.awayMore + 1})` : ''} · Go`}
        </Button>
      )}
      <Link className="fv-chat-open" to={itemHref({ kind: 'chat', projectId: target.projectId, workstream: target.workstream }, target.tab)}
        onClick={() => noteLastChat(target)}>Open</Link>
      {line.dismiss && (
        <Button variant="minimal" size="small" className="fv-chat-line-btn fv-chat-line-dismiss" aria-label="Dismiss" onPress={() => dispatchStrip(key, { type: 'dismiss' })}>×</Button>
      )}
    </div>
  );

  return (
    <div className="fv-chat-host" {...dropHandlers}>
      {dragging && <div className="chat-drop-overlay" aria-hidden="true">Drop images to attach</div>}
      <SdkComposer s={s} project={project} workstream={target.workstream} className="fv-chat" barStart={agentPicker} statusLine={statusLine}
        placeholderWho="an agent about this file" noReserve />
    </div>
  );
}
