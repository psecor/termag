// "Where this session runs", compact (under user-projects-enabled; PlacementPicker.tsx is the picker without it).
// With twenty boxes the picker grew past the window, a long list of near-identical "Asleep · wakes when you start
// · 1 session" rows pushing Session name and Done off the bottom. Here:
// - Auto and New box stay in sight above and below the boxes, which scroll in a capped area (about six rows).
// - Each box is one line, its name and its state short on the right ("Up · 1 session", "Asleep · 3 sessions");
//   its repositories, load and last use are in its tooltip.
// - The boxes that are up come first, then the asleep ones by last use under one "Asleep · wakes when you
//   start"; past a few, the rest fold under "N more asleep boxes". From FILTER_FROM boxes a filter field shows.
// LaunchPad's GridList with one selection, shared across its lists, so a row can carry its own actions: a box's ⋯
// has Release box…, which terminates it (DELETE /api/instances/:id, as Lab's Terminate) after a confirm that says
// what goes. Not on a box a session is working on, nor on a box of your own machine's (external) agent.
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert, AlertText, Button, ButtonGroup, Dialog, GridList, GridListItem, Heading, IconButton, Input, Menu, MenuItem, MenuTrigger,
  Modal, ModalOverlay, Popover, SearchField, Text, type GridListProps,
} from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { instancesApi } from '../../services/api';
import { boxFeed } from '../../services/boxFeed';
import { useProjects } from '../../contexts/ProjectContext';
import { LP_THEME } from '../../launchpad/theme';
import { projectWithLabel } from '../../utils/projectKind';
import type { Instance } from '../../types';
import { NEW_BOX } from './LaunchDrawer';
import { fmtAge } from '../../utils/format';
import {
  AUTO, autoLine, boxRowShort, boxRowTip, defaultWords, FILTER_FROM, newBoxSourceWords, pickerGroups, releaseLines, workingBoxIds,
  type PlacementBox, type PlacementView,
} from '../../chat/boxPlacement';
import './compactPlacementPicker.css';

type Selection = Parameters<NonNullable<GridListProps<object>['onSelectionChange']>>[0];

/** A box the placement doesn't list yet (it loaded before the box came), drawn from the box list as a plain row. */
function rowFromInstance(b: Instance): PlacementBox {
  return {
    instanceId: b.id, name: b.name, status: b.status, connected: true, heat: 'unknown', heatReasons: [], load: null,
    sessions: b.projects?.length ?? 0, hasRepos: false, checkoutProjectId: null, lastUsedAt: null,
  };
}

export interface CompactPlacementPickerProps {
  view: PlacementView | null;
  failed: boolean;
  onRetry: () => void;
  boxes: readonly Instance[];
  selection: string;
  onSelect: (choice: string) => void;
  autoName: string | null;
  newBoxTitle: string;
  newBoxCold?: boolean;
  repoWords: string | null;
  locked?: boolean;
  wakingId: string | null;
}

export function CompactPlacementPicker({ view, failed, onRetry, boxes, selection, onSelect, autoName, newBoxTitle, newBoxCold, repoWords, locked, wakingId }: CompactPlacementPickerProps) {
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState('');
  const [releasing, setReleasing] = useState<PlacementBox | null>(null);
  const working = workingBoxIds(useProjects().statusMap);
  const instanceOf = (id: string) => boxes.find(b => b.id === id);
  const byId = new Map((view?.boxes ?? []).map(b => [b.instanceId, b]));
  const rows: PlacementBox[] = [
    ...(view?.boxes ?? []).filter(b => boxes.some(i => i.id === b.instanceId)),
    ...boxes.filter(b => !byId.has(b.id)).map(rowFromInstance),
  ].map(r => (wakingId === r.instanceId ? { ...r, status: 'starting' } : r));
  // Auto with no placement to go on is New box, picked here and offered no further.
  const shown = failed && selection === AUTO ? NEW_BOX : selection;
  const groups = pickerGroups(rows, { expanded, filter, selected: shown });
  const auto = autoLine({ view, failed, name: autoName });
  const now = Date.now();
  // One selection across the lists: each shows it when it holds it, and a click elsewhere moves it.
  const pick = (next: Selection) => {
    if (next === 'all') return;
    const [k] = [...next].map(String);
    if (k) onSelect(k);
  };
  const listProps = (keys: readonly string[]) => ({
    selectionMode: 'single' as const,
    selectedKeys: keys.includes(shown) ? [shown] : [],
    disabledKeys: locked ? keys.filter(k => k !== shown) : [],
    onSelectionChange: pick,
  });
  const boxRow = (r: PlacementBox) => {
    const releasable = instanceOf(r.instanceId)?.kind === 'ec2' && !locked;
    const busy = working.has(r.instanceId);
    return (
      <GridListItem key={r.instanceId} id={r.instanceId} textValue={r.name} className="cp-row" data-heat={r.heat}
        data-tip={boxRowTip(r, repoWords, now, fmtAge)}>
        <span className="cp-name">{r.name}</span>
        <span className="cp-state">{boxRowShort(r)}</span>
        {releasable && (
          <MenuTrigger>
            <IconButton icon="more-horiz" variant="minimal" size="small" className="cp-more-btn" aria-label={`Options for ${r.name}`} />
            <Popover placement="bottom end" className={`${LP_THEME} chat-menu-popover cp-menu`}>
              <Menu aria-label={`${r.name}: actions`} disabledKeys={busy ? ['release'] : []}
                onAction={key => { if (key === 'release') setReleasing(r); }}>
                <MenuItem id="release" textValue="Release box…">
                  <Icon name="delete" size="medium" aria-hidden="true" />
                  <Text slot="label">Release box…</Text>
                  <Text slot="description">{busy ? "A session is working on it: release it once that's done" : 'Terminates it, after you confirm'}</Text>
                </MenuItem>
              </Menu>
            </Popover>
          </MenuTrigger>
        )}
      </GridListItem>
    );
  };
  return (
    // data-tips: the dialog is portalled out of .chat-root, and this lets the simple UI's tooltips show its rows' data-tip.
    <div className="cp" data-tips="">
      {failed && (
        <Alert status="error" className="chat-placement-alert">
          <Text elementType="p">Couldn't check your boxes. New box is picked; Send still works.</Text>
          <Button size="small" onPress={onRetry}>Retry</Button>
        </Alert>
      )}
      <GridList aria-label="Auto" className="cp-list cp-fixed" {...listProps([AUTO])} disabledKeys={locked && shown !== AUTO ? [AUTO] : failed ? [AUTO] : []}>
        <GridListItem id={AUTO} textValue="Auto (recommended)" className="cp-row cp-auto">
          <span className="cp-name">Auto <span className="chat-placement-recommended">(recommended)</span></span>
          {auto && <span className="cp-state cp-why">{auto}</span>}
        </GridListItem>
      </GridList>
      {rows.length >= FILTER_FROM && (
        <SearchField aria-label="Filter boxes" value={filter} onChange={setFilter} className="cp-filter">
          <Input placeholder="Filter boxes" />
        </SearchField>
      )}
      {rows.length > 0 && (
        <div className="cp-scroll" role="group" aria-label="Your boxes">
          {groups.up.length > 0 && (
            <>
              <div className="cp-head" id="cp-up">Up</div>
              <GridList aria-labelledby="cp-up" className="cp-list" {...listProps(groups.up.map(r => r.instanceId))}>
                {groups.up.map(boxRow)}
              </GridList>
            </>
          )}
          {groups.asleep.length > 0 && (
            <>
              <div className="cp-head" id="cp-asleep">Asleep · wakes when you start</div>
              <GridList aria-labelledby="cp-asleep" className="cp-list" {...listProps(groups.asleep.map(r => r.instanceId))}>
                {groups.asleep.map(boxRow)}
              </GridList>
            </>
          )}
          {groups.more > 0 && (
            <Button variant="minimal" size="small" className="cp-more" onPress={() => setExpanded(true)}>
              {groups.more} more asleep {groups.more === 1 ? 'box' : 'boxes'}
            </Button>
          )}
          {filter.trim() && groups.up.length + groups.asleep.length === 0 && <p className="cp-none">No box matches “{filter.trim()}”.</p>}
        </div>
      )}
      <GridList aria-label="New box" className="cp-list cp-fixed" {...listProps([NEW_BOX])}>
        <GridListItem id={NEW_BOX} textValue={newBoxTitle} className="cp-row">
          <span className="cp-name">{newBoxTitle}</span>
          <span className="cp-state">{newBoxSourceWords(newBoxCold ? 'cold' : view?.newBox.source ?? 'cold')}</span>
        </GridListItem>
      </GridList>
      {view && (
        <div className="chat-placement-default">
          {defaultWords(view.policy)} · <Link to="/settings#where-new-sessions-run">Change</Link>
        </div>
      )}
      {releasing && (
        <ReleaseBoxDialog box={releasing}
          onCancel={() => setReleasing(null)}
          onReleased={() => {
            const gone = releasing.instanceId;
            setReleasing(null);
            // The picked box went: the pick falls back to Auto, which the placement is asked again for.
            if (selection === gone) onSelect(AUTO);
            void boxFeed.reload();
            onRetry();
          }} />
      )}
    </div>
  );
}

/**
 * Release box…'s confirm: what goes with the box, then DELETE /api/instances/:id, confirmed (its projects archive with
 * it). The box list (GET /api/instances) doesn't carry a box's projects, so the confirm reads the box itself (GET
 * /api/instances/:id, its live projects, labelled) and offers Release only once it knows what it would take.
 */
function ReleaseBoxDialog({ box, onCancel, onReleased }: { box: PlacementBox; onCancel: () => void; onReleased: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [checkouts, setCheckouts] = useState<string[] | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let live = true;
    setReadFailed(false);
    instancesApi.get(box.instanceId)
      .then(b => { if (live) setCheckouts((b.projects ?? []).map(projectWithLabel)); })
      .catch(() => { if (live) setReadFailed(true); });
    return () => { live = false; };
  }, [box.instanceId, tries]);
  const release = async () => {
    setBusy(true); setError('');
    try {
      await instancesApi.terminate(box.instanceId, true);
      onReleased();
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error || `Couldn't release ${box.name}`);
      setBusy(false);
    }
  };
  return (
    <ModalOverlay isOpen isDismissable={!busy} onOpenChange={o => { if (!o && !busy) onCancel(); }} className={`${LP_THEME} cp-release-overlay`}>
      <Modal size="small" className="cp-release-modal">
        <Dialog role="alertdialog" className="cp-release-dialog">
          <Heading slot="title" level={2} size="medium">Release {box.name}?</Heading>
          {checkouts ? (
            <ul className="cp-release-lines">
              {releaseLines({ name: box.name, sessions: box.sessions, checkouts }).map(l => <li key={l}>{l}</li>)}
            </ul>
          ) : readFailed ? (
            <Alert status="error" hideIcon>
              <AlertText><p>Couldn't read what's on {box.name}, so it isn't released.</p></AlertText>
              <Button size="small" onPress={() => setTries(n => n + 1)}>Try again</Button>
            </Alert>
          ) : <p className="cp-release-lines cp-release-reading" role="status">Reading what's on {box.name}…</p>}
          {error && (
            <Alert status="error" hideIcon>
              <AlertText><p>{error}</p></AlertText>
            </Alert>
          )}
          <ButtonGroup className="cp-release-buttons">
            <Button variant="minimal" onPress={onCancel} isDisabled={busy}>Cancel</Button>
            <Button variant="destructive" autoFocus onPress={() => { void release(); }} isPending={busy} isDisabled={!checkouts}>Release {box.name}</Button>
          </ButtonGroup>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
