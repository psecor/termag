// The Share dialog's "In your browser" form:
// publish a port of the workstream's box as a preview link, which
// the people it's shared with open in their own browser at the app's own
// address. LaunchPad throughout; the server checks everything again.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Button, Checkbox, Disclosure, DisclosurePanel, FieldError, Group, Heading, IconButton, Input, Label,
  ListBox, ListBoxItem, NumberField, Popover, Radio, RadioGroup, Select, SelectValue, Text, TextField,
} from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { LP_THEME } from '../launchpad/theme';
import {
  previewLinkError, previewLinksApi, type PreviewLinkAudience, type PreviewLinkRequestView, type PreviewLinkView, type PreviewListener,
  type PublishedPreviewLink,
} from '../services/previewLinksApi';
import { MAX_LINK_LIFETIME_DAYS, MAX_TTL_HOURS, MIN_TTL_HOURS, clampTtlHours, nameProblem, parseEmails, suggestName } from './rules';
import { CopyUrl } from './CopyUrl';

export const LINK_WARNING = "Anyone you send this to can use the app as you've set it up, including its data.";

interface Props {
  projectId: string;
  projectName: string;
  workstream: string;
  /** The project's links, for what a name would renew; null while they load. */
  links: PreviewLinkView[] | null;
  ttlHoursDefault: number;
  /** preview-links-link-audience-enabled: "People I name" and "Anyone on termag with the link". */
  audiencesOn: boolean;
  /** A publish is in flight: the full UI's dialog can't be closed meanwhile. */
  onBusyChange?: (busy: boolean) => void;
  /** An agent's request being answered: its port is preselected and its id sent with the publish. */
  answering?: PreviewLinkRequestView | null;
  onCancelAnswer?: () => void;
  onPublished?: (made: PublishedPreviewLink) => void;
}

/** A row of the port list: a real listener, or an agent's asked port nothing listens on yet. */
type PortItem = PreviewListener & { unlistened?: boolean };

/** A listener the agent couldn't read the command of (Docker, another user's process) still listens: only the asked, absent port is "nothing listens yet". */
function listenerLabel(l: PortItem): string {
  if (l.unlistened) return `${l.port} · nothing listens yet`;
  return l.command ? `${l.port} · ${l.command}` : String(l.port);
}

/** The first port the box would publish, from this checkout before any other. */
function firstPublishable(list: PreviewListener[]): number | null {
  return (list.find(l => l.verdict.ok && l.inCheckout) ?? list.find(l => l.verdict.ok))?.port ?? null;
}

/** What publishing under `name` does to a live link of the project: renew ours, or be refused for another workstream's. */
export function nameNote(name: string, workstream: string, links: PreviewLinkView[] | null): string | null {
  const live = (links ?? []).find(l => l.name === name && l.live);
  if (!live) return null;
  return live.workstream === workstream
    ? 'This renews your live link with this name: same address, the new settings.'
    : `The ${live.workstream ?? 'main'} workstream has a live link with this name.`;
}

export function PublishPreviewLink({ projectId, projectName, workstream, links, ttlHoursDefault, audiencesOn, answering = null, onCancelAnswer, onBusyChange, onPublished }: Props) {
  const [listeners, setListeners] = useState<PreviewListener[] | null>(null);
  const [listenError, setListenError] = useState<string | null>(null);
  const [port, setPort] = useState<number | null>(null);
  const [name, setName] = useState(() => (projectName ? suggestName(projectName, workstream) ?? '' : ''));
  // Typed by the person: a late project name no longer replaces it.
  const [nameTyped, setNameTyped] = useState(false);
  const [audience, setAudience] = useState<PreviewLinkAudience>('owner');
  const [emails, setEmails] = useState('');
  const [ttl, setTtl] = useState(() => clampTtlHours(ttlHoursDefault));
  const [sendLocalhost, setSendLocalhost] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<PublishedPreviewLink | null>(null);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  // Only the latest listing counts, and a failed one keeps the list it had (Bugbot, #1485).
  const listing = useRef(0);
  const answeringRef = useRef(answering);
  answeringRef.current = answering;
  const loadListeners = useCallback(() => {
    const seq = ++listing.current;
    setListenError(null);
    previewLinksApi.listeners(projectId, workstream).then(list => {
      if (seq !== listing.current) return;
      setListeners(list);
      // An agent's asked port stays picked though nothing listens on it (Bugbot, #1486).
      setPort(p => (p !== null && (list.some(l => l.port === p && l.verdict.ok) || p === answeringRef.current?.port)) ? p : firstPublishable(list));
    }, err => {
      if (seq !== listing.current) return;
      setListeners(prev => prev ?? []);
      setListenError(previewLinkError(err));
    });
  }, [projectId, workstream]);
  useEffect(() => { loadListeners(); }, [loadListeners]);
  useEffect(() => { setTtl(clampTtlHours(ttlHoursDefault)); }, [ttlHoursDefault]);
  useEffect(() => { if (!audiencesOn) setAudience('owner'); }, [audiencesOn]);
  // An agent's request preselects its port; ending it goes back to the box's first.
  useEffect(() => { setPort(answering ? answering.port : firstPublishable(listeners ?? [])); }, [answering]); // eslint-disable-line react-hooks/exhaustive-deps
  // The projects can arrive after the dialog opens: suggest the name then, unless one was typed.
  useEffect(() => { if (!nameTyped && projectName) setName(suggestName(projectName, workstream) ?? ''); }, [projectName, workstream]); // eslint-disable-line react-hooks/exhaustive-deps

  const problem = name ? nameProblem(name) : 'Give the link a name.';
  const note = problem ? null : nameNote(name, workstream, links);
  const people = useMemo(() => parseEmails(emails), [emails]);
  // An agent may ask for a port nothing listens on yet, which the server publishes too (it's checked at every tunnel open).
  const items = useMemo((): PortItem[] => {
    const list = listeners ?? [];
    return answering && !list.some(l => l.port === answering.port)
      ? [...list, { port: answering.port, pid: null, command: null, verdict: { ok: true }, inCheckout: true, unlistened: true }]
      : list;
  }, [listeners, answering]);
  const disabledKeys = useMemo(() => items.filter(l => !l.verdict.ok).map(l => l.port), [items]);
  // An asked port the box refuses can't be published: say why, and don't offer Publish (Bugbot, #1486).
  const askedRefusal = answering ? (listeners ?? []).find(l => l.port === answering.port && !l.verdict.ok)?.verdict : undefined;
  const askedReason = askedRefusal && !askedRefusal.ok ? askedRefusal.reason : null;
  // Not before the box's listing is in: an asked port may be one it refuses (Bugbot, #1486).
  const ready = listeners !== null && port !== null && !problem && (audience !== 'people' || people.length > 0) && !busy && !askedReason;

  const publish = async () => {
    if (!ready || port === null) return;
    setBusy(true);
    setError(null);
    setMade(null);
    try {
      const res = await previewLinksApi.publish(projectId, {
        workstream, port, name, audience, ttlHours: ttl, hostMode: sendLocalhost ? 'localhost' : 'public',
        ...(audience === 'people' ? { emails: people } : {}),
        ...(answering ? { requestId: answering.id } : {}),
      });
      setMade(res);
      onPublished?.(res);
    } catch (err) {
      setError(previewLinkError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`${LP_THEME} preview-links-publish`}>
      {answering && (
        <div className="preview-links-answering" role="status">
          <Text elementType="p">
            {askedReason
              ? <>Port <code className="preview-links-mono">{answering.port}</code>, which an agent asked for, can't be published: {askedReason}</>
              : <>Publishing port <code className="preview-links-mono">{answering.port}</code>, as an agent asked. Choose who can open it.</>}
          </Text>
          <Button size="small" variant="minimal" onPress={() => onCancelAnswer?.()}>Cancel</Button>
        </div>
      )}
      <div className="preview-links-port">
        <Select
          className="preview-links-port-select"
          selectedKey={port}
          onSelectionChange={k => setPort(k == null ? null : Number(k))}
          disabledKeys={disabledKeys}
          placeholder={listeners === null ? 'Looking at the box…' : 'No port to publish'}
          // While answering a request, the port is the one asked for: a publish of another would use up the request (Devin, #1486).
          isDisabled={!items.length || !!answering}
        >
          <Label>Port on the box</Label>
          <Button className="preview-links-select-button">
            <SelectValue />
            <Icon name="chevron-down" size="medium" />
          </Button>
          <Popover className={`${LP_THEME} preview-links-port-popover`} placement="bottom start">
            <ListBox items={items}>
              {l => (
                <ListBoxItem id={l.port} textValue={listenerLabel(l)}>
                  <Text slot="label" className="preview-links-mono">{listenerLabel(l)}</Text>
                  {!l.verdict.ok && <Text slot="description" size="small">Can't be published: {l.verdict.reason}</Text>}
                  {l.verdict.ok && !l.inCheckout && !l.unlistened && <Text slot="description" size="small">Not started from this workstream's checkout</Text>}
                </ListBoxItem>
              )}
            </ListBox>
          </Popover>
        </Select>
        <IconButton icon="sync" variant="minimal" size="medium" aria-label="Look again" onPress={loadListeners} />
      </div>
      {listenError && <Text className="preview-links-error" elementType="p">{listenError}</Text>}
      {/* By what the select offers: an asked port nothing listens on yet is something to publish (Bugbot, #1486). */}
      {listeners !== null && items.length === 0 && !listenError && (
        <Text className="preview-links-hint" elementType="p">Nothing listens on this box yet. Start the app, then look again.</Text>
      )}

      <TextField value={name} onChange={v => { setNameTyped(true); setName(v.trim().toLowerCase()); }} isInvalid={!!problem && name !== ''} className="preview-links-name">
        <Label>Name</Label>
        <Input className="preview-links-mono" spellCheck={false} />
        {note && <Text slot="description" size="small">{note}</Text>}
        <FieldError>{problem}</FieldError>
      </TextField>

      <RadioGroup value={audience} onChange={v => setAudience(v as PreviewLinkAudience)} className="preview-links-audience">
        <Label>Who can open it</Label>
        <Radio value="owner">Only me</Radio>
        {audiencesOn && <Radio value="people">People I name</Radio>}
        {audiencesOn && <Radio value="link">Anyone on termag with the link</Radio>}
        {/* A plain paragraph: a RadioGroup takes one description, and this one belongs under its last choice. */}
        {audiencesOn && <p className="preview-links-warning">{LINK_WARNING}</p>}
      </RadioGroup>
      {audience === 'people' && (
        <TextField value={emails} onChange={setEmails} className="preview-links-emails">
          <Label>Their termag emails</Label>
          <Input placeholder="name@example.com, another@example.com" />
        </TextField>
      )}

      <NumberField value={ttl} onChange={v => setTtl(clampTtlHours(v))} minValue={MIN_TTL_HOURS} maxValue={MAX_TTL_HOURS} className="preview-links-ttl">
        <Label>Lifetime, in hours</Label>
        <Group className="preview-links-number">
          <Input />
          <IconButton slot="decrement" icon="minus" aria-label="Fewer hours" variant="minimal" size="medium" />
          <IconButton slot="increment" icon="add" aria-label="More hours" variant="minimal" size="medium" />
        </Group>
        <Text slot="description" size="small">
          {MIN_TTL_HOURS} to {MAX_TTL_HOURS} hours. You can extend it later, up to {MAX_LINK_LIFETIME_DAYS} days from its first publish.
        </Text>
      </NumberField>

      <Disclosure className="preview-links-advanced">
        {({ isExpanded }) => (
          <>
            <Heading level={5} className="preview-links-advanced-head">
              <Button slot="trigger" variant="minimal" size="small">
                <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size="medium" aria-hidden="true" />
                Advanced
              </Button>
            </Heading>
            <DisclosurePanel>
              <Checkbox isSelected={sendLocalhost} onChange={setSendLocalhost}>
                Send <code className="preview-links-mono">Host: localhost</code>
              </Checkbox>
              <Text elementType="p" size="small" className="preview-links-hint">
                Most dev servers answer only to localhost. Turn it off for an app that needs its own address.
              </Text>
            </DisclosurePanel>
          </>
        )}
      </Disclosure>

      <div className="preview-links-actions">
        <Button variant="primary" isDisabled={!ready} onPress={() => void publish()}>{busy ? 'Publishing…' : 'Publish'}</Button>
      </div>

      {error && <Alert status="error"><Text elementType="p">{error}</Text></Alert>}
      {made && <Published made={made} />}
    </div>
  );
}

function Published({ made }: { made: PublishedPreviewLink }) {
  const { link, renewed, shareUrl, note } = made;
  // A link audience opens only with its key. A renew that kept the key can't show it again, so the bare URL isn't offered (Devin, #1485).
  const keyless = link.audience === 'link' && !shareUrl;
  return (
    <Alert status="success" className="preview-links-result">
      <div className="preview-links-result-body">
        {keyless ? (
          <Text elementType="p">
            {renewed ? 'Renewed.' : 'Published.'} It keeps its key: share the URL you were given when you first published it. To get a new
            one, revoke the link and publish it again.
          </Text>
        ) : (
          <>
            <Text elementType="p">{renewed ? 'Renewed.' : 'Published.'} Share this URL:</Text>
            <CopyUrl value={shareUrl ?? link.url} label="the share URL" />
          </>
        )}
        {link.audience === 'link' && shareUrl && (
          <Text elementType="p" size="small">It holds the link's key, which termag shows only now: copy it before you close this.</Text>
        )}
        {note && !keyless && <Text elementType="p" size="small">{note}</Text>}
        {link.host && (
          <Text elementType="p" size="small">The app opens at <code className="preview-links-mono">{link.host}</code>, until {new Date(link.expiresAt).toLocaleString()}.</Text>
        )}
      </div>
    </Alert>
  );
}
