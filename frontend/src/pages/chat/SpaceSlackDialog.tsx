// A space's Slack channels, in the simple UI,
// opened from the space's ⋮ next to Share space (OpenItems.tsx): the
// linked channels with Unlink, then, for an owner, linking an existing channel
// (a server-searched ComboBox) or creating one, with the preview's bystander
// count and, on the first link, the runner's box. All LaunchPad, in termag's
// theme (LP_THEME) and UI font: channel names are labels too; ids appear only
// under Advanced, in monospace. Hidden while space-channels-enabled is off;
// the server (routes/spaceSlack.ts) refuses anyway. Wording is chat/spaceSlack.ts.
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  Button, ButtonGroup, ComboBox, Dialog, Disclosure, DisclosurePanel, FieldError, Group, Heading, IconButton, Input, Label,
  ListBox, ListBoxItem, Modal, ModalOverlay, Popover, ProgressBar, Radio, RadioGroup, Select, SelectValue, Switch, Text,
  TextField, GridList, GridListItem, Tooltip, TooltipTrigger,
} from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { boxFeed } from '../../services/boxFeed';
import {
  spaceSlackApi, type SlackPickerChannel, type SpaceSlackBox, type SpaceSlackChannel, type SpaceSlackPreview, type SpaceSlackStatus,
  type SpaceSlackTarget,
} from '../../services/api';
import { LP_THEME } from '../../launchpad/theme';
import { ensureLaunchPadSprite } from '../../launchpad/sprite';
import { channelNameProblem, defaultChannelName, GONE_BOX_STATUSES, linkedLine, pickerHint, previewLines, slackErrorText } from '../../chat/spaceSlack';
import './SpaceSlackDialog.css';

const NEW_BOX = '__new__';
const SEARCH_DEBOUNCE_MS = 250;
/** Picker answers one search follows (each covers up to 1,000 Slack channels). */
const SEARCH_PAGES = 10;

/**
 * The picker's channels for what was typed, searched on the server (private
 * ones only where you are a member). Each answer covers part of the workspace
 * and gives a cursor for the rest, so it follows the cursor (up to
 * SEARCH_PAGES answers), adding each page as it comes.
 */
function useChannelSearch(query: string, enabled: boolean, linkedKey: string) {
  const [channels, setChannels] = useState<SlackPickerChannel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    // A new query starts empty: the last one's channels (and its error) must not be picked or shown meanwhile.
    setChannels([]);
    setError(null);
    setLoading(true);
    const t = setTimeout(() => {
      void (async () => {
        try {
          let cursor: string | undefined;
          const seen = new Map<string, SlackPickerChannel>();
          for (let page = 0; page < SEARCH_PAGES; page++) {
            const r = await spaceSlackApi.channels(query.replace(/^#/, ''), cursor);
            if (!live) return;
            for (const c of r.channels) seen.set(c.id, c);
            setChannels([...seen.values()]);
            setError(null);
            if (!r.nextCursor) break;
            cursor = r.nextCursor;
          }
        } catch (err) {
          if (live) setError(slackErrorText(err, 'Could not list the channels'));
        } finally {
          if (live) setLoading(false);
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => { live = false; clearTimeout(t); };
  // linkedKey: the space's linked channels; a link or unlink changes which entries are disabled, so search again.
  }, [query, enabled, linkedKey]);
  return { channels, loading, error };
}

function ChannelName({ name, isPrivate }: { name: string; isPrivate: boolean }) {
  return (
    <span className="space-slack-channel-name">
      {isPrivate ? <Icon name="lock" size="small" aria-label="Private" /> : <Icon name="hash" size="small" aria-hidden="true" />}
      {name}
    </span>
  );
}

function UnlinkDialog({ space, channel, onClose, onUnlinked }: {
  space: string; channel: SpaceSlackChannel; onClose: () => void; onUnlinked: () => void;
}) {
  const [info, setInfo] = useState<{ threads: number | null; canArchive: boolean } | null>(null);
  // The preview failed: unlinking still works (the server checks again), just without its counts or archiving.
  const [previewFailed, setPreviewFailed] = useState(false);
  const [archive, setArchive] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    spaceSlackApi.unlinkPreview(space, channel.channelId)
      .then(r => setInfo({ threads: r.threads, canArchive: r.canArchive }))
      .catch(err => { setPreviewFailed(true); setError(`${slackErrorText(err, 'Could not check the channel')} You can still unlink it.`); });
  }, [space, channel.channelId]);
  const unlink = () => {
    setPending(true);
    setError(null);
    spaceSlackApi.unlink(space, channel.channelId, archive)
      .then(() => onUnlinked())
      .catch(err => { setError(slackErrorText(err, 'Could not unlink the channel')); setPending(false); });
  };
  return (
    <ModalOverlay isOpen isDismissable={!pending} onOpenChange={open => { if (!open) onClose(); }} className={LP_THEME}>
      <Modal size="small" className="space-slack-modal">
        <Dialog className="space-slack-dialog" role="alertdialog" aria-label={`Unlink ${channel.name}`}>
          <Heading slot="title" level={2} size="medium">Unlink #{channel.name}?</Heading>
          <p className="space-slack-text">
            termag stops answering for {space} in #{channel.name}
            {info?.threads ? `, and ${info.threads} ${info.threads === 1 ? 'thread' : 'threads'} there stop answering` : ''}.
            The channel and its messages stay in Slack.
          </p>
          {info?.canArchive && (
            <Switch isSelected={archive} onChange={setArchive} isDisabled={pending}>Also archive the channel (termag created it)</Switch>
          )}
          {error && <p className="space-slack-error" role="alert">{error}</p>}
          <ButtonGroup className="space-slack-actions">
            <Button variant="default" onPress={onClose} isDisabled={pending}>Cancel</Button>
            <Button variant="destructive" onPress={unlink} isPending={pending} isDisabled={!info && !previewFailed}>Unlink</Button>
          </ButtonGroup>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function LinkForm({ space, status, onLinked }: { space: string; status: SpaceSlackStatus; onLinked: (note: string) => void }) {
  const [mode, setMode] = useState<'existing' | 'create'>('existing');
  /** What the field shows. */
  const [query, setQuery] = useState('');
  /** What is searched: what the person typed, never a pick's label. */
  const [searchQuery, setSearchQuery] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  /** The picked channel's name, for onInputChange (set synchronously with the pick). */
  const pickedName = useRef<string | null>(null);
  const [name, setName] = useState(defaultChannelName(space));
  const [isPrivate, setPrivate] = useState(false);
  const [invite, setInvite] = useState(false);
  const [box, setBox] = useState<string>(NEW_BOX);
  const [preview, setPreview] = useState<SpaceSlackPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Bumped by Check again: the same target, previewed afresh (after /invite @termag, or a failed check).
  const [recheck, setRecheck] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const myBoxes = useSyncExternalStore(boxFeed.subscribe, boxFeed.getSnapshot);
  // Boxes a first link accepts (the backend refuses gone ones: enable.ts GONE_BOX_STATUSES).
  const liveBoxes = myBoxes.filter(b => !GONE_BOX_STATUSES.has(b.status));
  const full = status.channels.length >= status.caps.channelsPerSpace;
  // No search while the picker isn't shown (a full space shows none): it costs Slack calls.
  const search = useChannelSearch(searchQuery, mode === 'existing' && !full, status.channels.map(c => c.channelId).join(','));
  const nameProblem = mode === 'create' ? channelNameProblem(name) : null;

  const target: SpaceSlackTarget | null = mode === 'existing'
    ? (picked ? { channelId: picked } : null)
    : (nameProblem ? null : { create: { name, private: isPrivate, inviteMembers: invite } });
  const targetKey = JSON.stringify(target);

  // The preview, again whenever the target changes.
  const seq = useRef(0);
  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
    // A refusal belongs to the target it was for.
    setError(null);
    // Advanced even with no target, so an answer still in flight for the old one is dropped.
    const mine = ++seq.current;
    if (!target) return;
    spaceSlackApi.preview(space, target)
      .then(p => { if (mine === seq.current) setPreview(p); })
      .catch(err => { if (mine === seq.current) setPreviewError(slackErrorText(err, 'Could not check the channel')); });
  }, [space, targetKey, recheck]);

  const firstLink = !status.enabled;
  const runnerBox: SpaceSlackBox | undefined = firstLink ? (box === NEW_BOX ? { new: { size: 'small' } } : { existing: box }) : undefined;
  const canLink = !!target && !!preview && !preview.needsInvite && !preview.alreadyLinked && !pending && !full;
  const allowPrivate = status.caps.allowPrivate;
  const disabledKeys = useMemo(
    () => search.channels.filter(c => c.disabled || (c.private && !allowPrivate)).map(c => c.id),
    [search.channels, allowPrivate],
  );

  const submit = () => {
    if (!target) return;
    setPending(true);
    setError(null);
    spaceSlackApi.link(space, target, runnerBox)
      .then(r => {
        const failed = r.failedInvites.length ? ` ${r.failedInvites.length} invite(s) failed.` : '';
        onLinked(r.already ? `#${r.channel.name} was already linked.` : `Linked #${r.channel.name} to ${space}.${failed}`);
        // Back to an empty form, so a second press can't send the same link or create again.
        setPicked(null);
        pickedName.current = null;
        setQuery('');
        setSearchQuery('');
        setMode('existing');
        setName('');
        setPreview(null);
      })
      .catch(err => setError(slackErrorText(err, 'Could not link the channel')))
      .finally(() => setPending(false));
  };

  if (full) {
    return <p className="space-slack-text">{space} has {status.caps.channelsPerSpace} linked channels, the most it can have. Unlink one to link another.</p>;
  }

  return (
    <section className="space-slack-section" aria-label="Link a channel">
      <Heading level={3} size="small" className="space-slack-heading">Link a channel</Heading>
      <RadioGroup value={mode} onChange={v => setMode(v as 'existing' | 'create')} orientation="horizontal" aria-label="Link or create" isDisabled={pending}>
        <Radio value="existing">An existing channel</Radio>
        <Radio value="create">A new channel</Radio>
      </RadioGroup>

      {mode === 'existing' ? (
        <ComboBox
          isDisabled={pending}
          className="space-slack-combobox"
          items={search.channels}
          inputValue={query}
          onInputChange={t => {
            setQuery(t);
            // The text a pick puts in the field is its label, not a search: searching it would replace the list
            // the selection lives in. Compared with a ref, which a pick made in this same turn has already set.
            if (pickedName.current !== null && t === pickedName.current) return;
            // Anything else typed is a search, and a pick the text no longer names is dropped.
            if (pickedName.current !== null) { pickedName.current = null; setPicked(null); }
            setSearchQuery(t);
          }}
          selectedKey={picked}
          onSelectionChange={key => {
            const id = key == null ? null : String(key);
            pickedName.current = id ? search.channels.find(c => c.id === id)?.name ?? null : null;
            setPicked(id);
            // The text is ours (a controlled inputValue): show the pick's name, which is a label, not a search.
            if (pickedName.current !== null) setQuery(pickedName.current);
          }}
          disabledKeys={disabledKeys}
          menuTrigger="focus"
          allowsEmptyCollection
        >
          <Label>Channel</Label>
          <Group className="space-slack-combobox-group">
            <Input placeholder="Search channels" />
            <IconButton icon="chevron-down" aria-label="Show channels" variant="minimal" size="small" />
          </Group>
          <Text slot="description" size="small">You can link a channel you're a member of, public or private; a private one needs termag in it too.</Text>
          {search.error && <Text slot="errorMessage" size="small" className="space-slack-error">{search.error}</Text>}
          <Popover className={LP_THEME} maxHeight={320}>
            <ListBox<SlackPickerChannel> renderEmptyState={() => <div className="space-slack-empty">{search.loading ? 'Searching…' : 'No channels match'}</div>}>
              {c => (
                <ListBoxItem id={c.id} textValue={c.name}>
                  <Text slot="label"><ChannelName name={c.name} isPrivate={c.private} /></Text>
                  <Text slot="description" size="small">{pickerHint(c, space, { allowPrivate })}</Text>
                </ListBoxItem>
              )}
            </ListBox>
          </Popover>
        </ComboBox>
      ) : (
        <div className="space-slack-create">
          <TextField value={name} onChange={v => setName(v.trim().toLowerCase())} isInvalid={!!nameProblem} validationBehavior="aria" isDisabled={pending}>
            <Label>Channel name</Label>
            <Input maxLength={80} />
            <Text slot="description" size="small">Lowercase letters, digits, - and _.</Text>
            <FieldError>{nameProblem}</FieldError>
          </TextField>
          {status.caps.allowPrivate && <Switch isSelected={isPrivate} onChange={setPrivate} isDisabled={pending}>Private channel</Switch>}
          <Switch isSelected={invite} onChange={setInvite} isDisabled={pending}>Invite {space}'s members</Switch>
        </div>
      )}

      {firstLink && (
        <Select className="space-slack-select" selectedKey={box} onSelectionChange={key => { if (key != null) setBox(String(key)); }} isDisabled={pending}>
          <Label>Runner's box</Label>
          <Button className="space-slack-select-button">
            <SelectValue />
            <Icon name="chevron-down" size="small" />
          </Button>
          <Text slot="description" size="small">Where {space}'s orchestrator runs, as you.</Text>
          <Popover className={LP_THEME}>
            <ListBox>
              <ListBoxItem id={NEW_BOX} textValue="A new small box">A new small box</ListBoxItem>
              {liveBoxes.map(b => <ListBoxItem key={b.id} id={b.id} textValue={b.name}>{b.name}</ListBoxItem>)}
            </ListBox>
          </Popover>
        </Select>
      )}

      {target && !preview && !previewError && <ProgressBar isIndeterminate size="small" variant="spinner" aria-label="Checking the channel" />}
      {previewError && <p className="space-slack-error" role="alert">{previewError}</p>}
      {preview && (
        <ul className="space-slack-preview" aria-label="Before you link">
          {previewLines(preview, space).map(l => (
            <li key={l.text} data-tone={l.tone}>
              <Icon name={l.tone === 'warning' ? 'warning' : 'info'} size="small" aria-hidden="true" />
              <span>{l.text}</span>
            </li>
          ))}
        </ul>
      )}
      {target && (preview?.needsInvite || previewError) && (
        <ButtonGroup className="space-slack-actions">
          <Button size="small" variant="default" onPress={() => setRecheck(n => n + 1)}>Check again</Button>
        </ButtonGroup>
      )}
      {error && <p className="space-slack-error" role="alert">{error}</p>}
      <ButtonGroup className="space-slack-actions">
        <Button variant="primary" onPress={submit} isDisabled={!canLink} isPending={pending}>
          {mode === 'create' ? 'Create and link' : 'Link channel'}
        </Button>
      </ButtonGroup>
    </section>
  );
}

export function SpaceSlackDialog({ space, onClose }: { space: string; onClose: () => void }) {
  useEffect(() => { void ensureLaunchPadSprite(); }, []);
  const [status, setStatus] = useState<SpaceSlackStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState<SpaceSlackChannel | null>(null);
  const [pausing, setPausing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Only the newest request's answer lands: an older one (link, unlink, pause and Try again can overlap) is dropped.
  const loadSeq = useRef(0);
  const load = () => {
    const mine = ++loadSeq.current;
    return spaceSlackApi.status(space)
      // A newer status supersedes an older action's error (a pause that failed before this link or unlink).
      .then(s => { if (mine === loadSeq.current) { setStatus(s); setLoadError(null); setActionError(null); } })
      .catch(err => { if (mine === loadSeq.current) setLoadError(slackErrorText(err, 'Could not load the space\'s Slack channels')); });
  };
  useEffect(() => { void load(); }, [space]);

  const owner = !!status?.you.owner;
  const togglePause = () => {
    if (!status) return;
    setPausing(true);
    setActionError(null);
    // Its answer is a status too: it takes a load ticket, so it never overwrites a newer list, and replaces a stale one's error.
    const mine = ++loadSeq.current;
    (status.status === 'paused' ? spaceSlackApi.resume(space) : spaceSlackApi.pause(space))
      .then(s => { if (mine === loadSeq.current) { setStatus(s); setLoadError(null); } })
      // Its error belongs to the state it was made on: a newer status (an unlink's, a retry's) supersedes it.
      .catch(err => { if (mine === loadSeq.current) setActionError(slackErrorText(err, 'Could not change it')); })
      .finally(() => setPausing(false));
  };

  const runnerLine = status?.enabled
    ? `Runner: ${status.runner?.email ?? 'someone'}${status.you.runner ? ' (you)' : ''}, on ${status.box?.kind === 'existing' ? status.box.name : 'a new small box'}`
    : null;

  return (
    <>
      <ModalOverlay isOpen isDismissable onOpenChange={open => { if (!open) onClose(); }} className={LP_THEME}>
        <Modal size="medium" className="space-slack-modal">
          <Dialog className="space-slack-dialog" aria-label={`Slack channels for ${space}`}>
            <Heading slot="title" level={2} size="medium">Slack channels for {space}</Heading>
            {!status && <p className="space-slack-text">{loadError ?? 'Loading…'}</p>}
            {status && (
              <>
                <p className="space-slack-text">
                  People in a linked channel talk to {space} by mentioning @termag there.
                  {status.slack === 'fake' && ' This termag uses a fake Slack workspace: nothing is posted to Slack.'}
                  {status.slack === 'none' && ' Slack isn\'t configured on this termag.'}
                </p>
                {status.enabled ? (
                  <div className="space-slack-runner">
                    <span>{runnerLine}{status.status === 'paused' ? ' · Paused' : status.status === 'suspended' ? ' · Suspended' : ''}</span>
                    {owner && status.status !== 'suspended' && (
                      <TooltipTrigger>
                        <Button size="small" variant="default" onPress={togglePause} isPending={pausing}>
                          {status.status === 'paused' ? 'Resume' : 'Pause'}
                        </Button>
                        <Tooltip className={LP_THEME}>{status.status === 'paused' ? 'termag answers in these channels again' : 'termag stops answering in these channels until you resume'}</Tooltip>
                      </TooltipTrigger>
                    )}
                  </div>
                ) : (
                  <p className="space-slack-text">Slack isn't on for {space} yet.{owner ? ' Linking its first channel turns it on, with you as its runner.' : ''}</p>
                )}
                {note && <p className="space-slack-note" role="status">{note}</p>}
                {actionError && <p className="space-slack-error" role="alert">{actionError}</p>}
                {loadError && (
                  <div className="space-slack-runner" role="alert">
                    <span className="space-slack-error">Couldn't refresh the list ({loadError}); it may be out of date.</span>
                    <Button size="small" variant="default" onPress={() => void load()}>Try again</Button>
                  </div>
                )}

                <section className="space-slack-section" aria-label="Linked channels">
                  <Heading level={3} size="small" className="space-slack-heading">
                    Linked channels · {status.channels.length} of {status.caps.channelsPerSpace}
                  </Heading>
                  <GridList aria-label="Linked channels" items={status.channels} className="space-slack-list"
                    renderEmptyState={() => <div className="space-slack-empty">No channels linked yet.</div>}>
                    {c => (
                      <GridListItem id={c.channelId} textValue={c.name}>
                        <div className="space-slack-row">
                          <span className="space-slack-row-text">
                            <ChannelName name={c.name} isPrivate={c.private} />
                            <span className="space-slack-sub">{linkedLine(c)}</span>
                          </span>
                          {owner && <Button size="small" variant="default" onPress={() => setUnlinking(c)} aria-label={`Unlink ${c.name}`}>Unlink</Button>}
                        </div>
                      </GridListItem>
                    )}
                  </GridList>
                </section>

                {owner
                  ? <LinkForm space={space} status={status} onLinked={n => { setNote(n); void load(); }} />
                  : <p className="space-slack-text">Only {space}'s owners link and unlink its channels.</p>}

                {status.channels.length > 0 && (
                  <Disclosure className="space-slack-advanced">
                    <Button slot="trigger" variant="minimal" size="small">Advanced</Button>
                    <DisclosurePanel>
                      <ul className="space-slack-ids" aria-label="Channel ids">
                        {status.channels.map(c => <li key={c.channelId}><span>#{c.name}</span> <code>{c.channelId}</code></li>)}
                      </ul>
                    </DisclosurePanel>
                  </Disclosure>
                )}
              </>
            )}
            <ButtonGroup className="space-slack-actions">
              <Button variant="default" onPress={onClose}>Close</Button>
            </ButtonGroup>
          </Dialog>
        </Modal>
      </ModalOverlay>
      {unlinking && (
        <UnlinkDialog space={space} channel={unlinking} onClose={() => setUnlinking(null)}
          onUnlinked={() => { setNote(`Unlinked #${unlinking.name}.`); setUnlinking(null); void load(); }} />
      )}
    </>
  );
}
