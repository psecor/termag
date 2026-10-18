import React, { useState } from 'react';
import { Dialog } from './Dialog';

export type ShareKind = 'fyi' | 'help';

export interface ShareDraft {
  kind: ShareKind;
  ask: string;
  context: string[];
  tried?: string;
  helpWanted?: string;
  to: { channel?: string; people?: string[] };
}

/**
 * Write a Slack card about one workstream and send it.
 * The person writes it here, so this form is the preview: Send posts it as
 * the termag bot on their behalf. Agents draft through draft_slack_message
 * instead and the person previews those in Slack.
 */
export function ShareToSlackDialog({ title, busy, error, sent, onSend, onCancel }: {
  title: string;
  busy: boolean;
  error: string;
  /** After a send: the Slack permalink ('' when Slack gave none); null before. */
  sent: string | null;
  onSend: (draft: ShareDraft) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<ShareKind>('fyi');
  const [ask, setAsk] = useState('');
  const [context, setContext] = useState('');
  const [tried, setTried] = useState('');
  const [helpWanted, setHelpWanted] = useState('');
  const [where, setWhere] = useState<'project' | 'dm'>('project');
  const [people, setPeople] = useState('');

  const peopleList = people.split(/[\s,]+/).map(p => p.trim()).filter(Boolean);
  const dmNeedsOne = where === 'dm' && peopleList.length !== 1;
  const canSend = !busy && ask.trim().length > 0 && !dmNeedsOne;

  const submit = () => {
    if (!canSend) return;
    onSend({
      kind,
      ask: ask.trim(),
      context: context.split('\n').map(l => l.trim()).filter(Boolean),
      ...(kind === 'help' && tried.trim() ? { tried: tried.trim() } : {}),
      ...(kind === 'help' && helpWanted.trim() ? { helpWanted: helpWanted.trim() } : {}),
      to: where === 'dm' ? { people: peopleList } : { channel: 'project', ...(peopleList.length ? { people: peopleList } : {}) },
    });
  };

  if (sent !== null) {
    return (
      <Dialog title={<>Share to Slack · {title}</>} className="np-dialog" onClose={onCancel}>
        <div className="npf">
          <div className="npf-field">
            ✅ Sent.{' '}
            {sent ? <a href={sent} target="_blank" rel="noreferrer">View it in Slack</a> : 'It is in the workstream\'s Slack channel.'}
          </div>
          <div className="npf-actions">
            <button type="button" className="btn-primary" onClick={onCancel} autoFocus>Done</button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title={<>Share to Slack · {title}</>} className="np-dialog" onClose={onCancel} closeDisabled={busy}>
      <form className="npf" onSubmit={e => { e.preventDefault(); submit(); }}>
        <div className="npf-field">
          <label htmlFor="share-kind">What is it?</label>
          <select id="share-kind" value={kind} onChange={e => setKind(e.target.value as ShareKind)} disabled={busy} autoFocus>
            <option value="fyi">FYI: check out what I'm working on</option>
            <option value="help">Help: I'm stuck, can you take a look?</option>
          </select>
        </div>
        <div className="npf-field">
          <label htmlFor="share-ask">The ask, in one line</label>
          <input
            id="share-ask" type="text" maxLength={200} value={ask} disabled={busy}
            placeholder={kind === 'help' ? 'Can you look at why the status tests hang on the box?' : 'The new dashboard is live on stage, have a look'}
            onChange={e => setAsk(e.target.value.replace(/\n/g, ' '))}
          />
        </div>
        <div className="npf-field">
          <label htmlFor="share-context">Context, one bullet per line</label>
          <textarea id="share-context" rows={4} value={context} disabled={busy} onChange={e => setContext(e.target.value)} />
        </div>
        {kind === 'help' && (
          <>
            <div className="npf-field">
              <label htmlFor="share-tried">What I tried</label>
              <textarea id="share-tried" rows={2} maxLength={800} value={tried} disabled={busy} onChange={e => setTried(e.target.value)} />
            </div>
            <div className="npf-field">
              <label htmlFor="share-help">What would help</label>
              <input id="share-help" type="text" maxLength={300} value={helpWanted} disabled={busy}
                placeholder="A gut check is enough" onChange={e => setHelpWanted(e.target.value)} />
            </div>
          </>
        )}
        <div className="npf-field">
          <label htmlFor="share-where">Where</label>
          <select id="share-where" value={where} onChange={e => setWhere(e.target.value as 'project' | 'dm')} disabled={busy}>
            <option value="project">This workstream's Slack channel</option>
            <option value="dm">A DM to one person</option>
          </select>
        </div>
        <div className="npf-field">
          <label htmlFor="share-people">{where === 'dm' ? 'Who (an email)' : 'Mention (emails, optional)'}</label>
          <input id="share-people" type="text" value={people} disabled={busy} placeholder="name@example.com" onChange={e => setPeople(e.target.value)} />
          <div className="npf-note usage-dim">
            Posted by the termag bot on your behalf, signed as you. Replies come back to you in Slack, and to this
            workstream's agent the next time it is idle.
          </div>
        </div>
        {error && <div className="error-text" role="alert">{error}</div>}
        <div className="npf-actions">
          <button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={!canSend}>{busy ? 'Sending…' : 'Send'}</button>
        </div>
      </form>
    </Dialog>
  );
}
