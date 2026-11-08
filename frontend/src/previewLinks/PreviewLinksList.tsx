// The project's preview links, under the Share dialog's publish form:
// each link with its URL to
// copy, its expiry and the latest it can be extended to, the people named and
// who opened it (Remove), Extend and Revoke; then the agents' pending asks to
// publish a port, each with its note (the agent's words, shown as plain text),
// Publish and Decline. The server decides who may change what: a refusal
// shows as its error.
import React, { useRef, useState } from 'react';
import { Button, ButtonGroup, Heading, Text } from '@launchpad-ui/components';
import { LP_THEME } from '../launchpad/theme';
import {
  previewLinkError, previewLinksApi, type PreviewLinkRequestView, type PreviewLinkView,
} from '../services/previewLinksApi';
import { CopyUrl } from './CopyUrl';

const AUDIENCE_LABEL: Record<PreviewLinkView['audience'], string> = {
  owner: 'Only you',
  people: 'People you named',
  link: 'Anyone on termag with the link',
};

const END_LABEL: Record<string, string> = {
  revoked: 'revoked', expired: 'expired', admin: 'ended by an admin', 'box-gone': 'ended: its box is gone',
  'project-gone': 'ended: its project was archived', 'workstream-gone': 'ended: its workstream was removed', 'kill-switch': 'ended by the kill switch',
};

export function relative(iso: string, now: number): string {
  const ms = Date.parse(iso) - now;
  const abs = Math.abs(ms);
  const [size, unit] = abs >= 86_400_000 ? [86_400_000, 'day'] : abs >= 3_600_000 ? [3_600_000, 'hour'] : [60_000, 'minute'];
  const n = Math.max(1, Math.round(abs / size));
  const text = `${n} ${unit}${n === 1 ? '' : 's'}`;
  return ms >= 0 ? `in ${text}` : `${text} ago`;
}

function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Whether Extend by `ttlHours` from now would move the expiry: later than now, and short of the 30-day cap. */
export function extendable(link: PreviewLinkView, ttlHours: number, now: number): boolean {
  return link.live && Date.parse(link.expiresAt) < Date.parse(link.maxExpiresAt) && now + ttlHours * 3_600_000 > Date.parse(link.expiresAt);
}

interface Props {
  links: PreviewLinkView[];
  requests: PreviewLinkRequestView[];
  /** Extend's step: the server's default lifetime. */
  ttlHoursDefault: number;
  /** Something changed here: read the list again. */
  onChanged: () => void;
  /** Publish an agent's request: the form above takes its port. */
  onAnswer: (request: PreviewLinkRequestView) => void;
  /** This dialog's workstream: only its own agents' requests can be published from here. */
  workstream: string;
  /** A request's workstream name, from its id (the project's workstreams); null when unknown. */
  workstreamName: (id: string | null) => string | null;
  /** Whom the server never removes from a link (its creator, the project's owner): no Remove beside them. */
  unremovable: (link: PreviewLinkView, userId: string) => boolean;
}

export function PreviewLinksList({ links, requests, ttlHoursDefault, onChanged, onAnswer, workstream, workstreamName, unremovable }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const now = Date.now();

  // One change at a time: every action is disabled while one is in flight, so no click is dropped unseen (Devin, #1486);
  // the ref is set at once, not after a render, so a double-click sends one request (Bugbot, #1486).
  const inFlight = useRef(false);
  const act = async (key: string, fn: () => Promise<unknown>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(key);
    setError(null);
    try { await fn(); } catch (err) { setError(previewLinkError(err)); }
    inFlight.current = false;
    setBusy(null);
    onChanged();
  };

  return (
    <div className={`${LP_THEME} preview-links-list`}>
      {error && <p className="preview-links-error" role="alert">{error}</p>}
      {requests.length > 0 && (
        <section aria-label="Agent requests" className="preview-links-section">
          <Heading level={4} className="preview-links-section-title">Agents asking to publish</Heading>
          {requests.map(r => (
            <div key={r.id} className="preview-links-row">
              <div className="preview-links-row-main">
                <Text elementType="p">
                  Port <code className="preview-links-mono">{r.port}</code> on {workstreamName(r.workstreamId) ?? 'an unknown workstream'}, asked {relative(r.createdAt, now)}
                </Text>
                {workstreamName(r.workstreamId) !== workstream && (
                  <Text elementType="p" size="small" className="preview-links-hint">
                    Open Share on {workstreamName(r.workstreamId) ?? 'its workstream'} to publish it: a request publishes its own workstream's port.
                  </Text>
                )}
                {r.note && (
                  <figure className="preview-links-note">
                    <figcaption>The agent's note, in its own words:</figcaption>
                    {/* Untrusted: plain text, never markup or a link. */}
                    <blockquote>{r.note}</blockquote>
                  </figure>
                )}
              </div>
              <ButtonGroup className="preview-links-row-actions">
                <Button size="small" isDisabled={workstreamName(r.workstreamId) !== workstream} onPress={() => onAnswer(r)}>Publish…</Button>
                <Button size="small" isDisabled={busy !== null} onPress={() => void act(r.id, () => previewLinksApi.declineRequest(r.id))}>Decline</Button>
              </ButtonGroup>
            </div>
          ))}
        </section>
      )}
      <section aria-label="Preview links" className="preview-links-section">
        <Heading level={4} className="preview-links-section-title">This project's links</Heading>
        {links.length === 0 && <Text elementType="p" className="preview-links-hint">No links yet.</Text>}
        {links.map(l => (
          <div key={l.id} className={`preview-links-row${l.live ? '' : ' preview-links-row-ended'}`}>
            <div className="preview-links-row-main">
              <Text elementType="p">
                <strong className="preview-links-mono">{l.name}</strong>
                <span className="preview-links-hint"> · {AUDIENCE_LABEL[l.audience]} · {l.workstream ?? 'main'}, port <code className="preview-links-mono">{l.port}</code></span>
              </Text>
              {/* A link audience opens only with its key, which termag shows once at publish: the bare URL here would let nobody in (Devin, #1486). */}
              {l.live && l.audience !== 'link' && <CopyUrl value={l.url} label={`the URL of ${l.name}`} />}
              {l.live && l.audience === 'link' && (
                <Text elementType="p" size="small" className="preview-links-hint">Share the URL with its key, from when you published it; termag doesn't keep the key.</Text>
              )}
              {l.live && l.host && <Text elementType="p" size="small" className="preview-links-hint">Opens at <code className="preview-links-mono">{l.host}</code></Text>}
              <Text elementType="p" size="small" className="preview-links-hint">
                {l.live
                  ? `Ends ${relative(l.expiresAt, now)}; can be extended until ${day(l.maxExpiresAt)}`
                  : `${END_LABEL[l.endReason ?? ''] ?? 'ended'} ${l.endedAt ? relative(l.endedAt, now) : ''}`.trim()}
              </Text>
              {(l.grantees ?? []).length > 0 && (
                <Text elementType="p" size="small" className="preview-links-hint">Named: {(l.grantees ?? []).map(g => g.displayName || g.email).join(', ')}</Text>
              )}
              {(l.viewers ?? []).length > 0 && (
                <ul className="preview-links-viewers" aria-label={`Who opened ${l.name}`}>
                  {(l.viewers ?? []).map(v => (
                    <li key={v.id}>
                      <span title={v.email}>{v.displayName || v.email}</span>
                      <span className="preview-links-hint"> {v.revokedAt ? 'removed' : `opened ${relative(v.lastOpenedAt, now)}`}</span>
                      {!v.revokedAt && l.live && !unremovable(l, v.id) && (
                        <Button size="small" variant="minimal" isDisabled={busy !== null}
                          onPress={() => void act(`${l.id}:${v.id}`, () => previewLinksApi.removeViewer(l.id, v.id))}>Remove</Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {l.live && (
              <ButtonGroup className="preview-links-row-actions">
                {extendable(l, ttlHoursDefault, now) && (
                  <Button size="small" isDisabled={busy !== null} onPress={() => void act(l.id, () => previewLinksApi.extend(l.id, ttlHoursDefault))}>
                    Extend to {ttlHoursDefault} h from now
                  </Button>
                )}
                <Button size="small" variant="destructive" isDisabled={busy !== null} onPress={() => void act(l.id, () => previewLinksApi.revoke(l.id))}>Revoke</Button>
              </ButtonGroup>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
