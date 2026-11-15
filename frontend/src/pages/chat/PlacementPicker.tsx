// "Where this session runs" with Runs on: Auto, inside
// New session's box dialog (pages/chat/LaunchDrawer.tsx): Auto with its reason,
// then your boxes (state, a load meter, sessions, whether each has the
// repository; hot ones sunk with why, still pickable), then New box with where
// it comes from. LaunchPad's ListBox with one selection, as RepoPicker's
// repository list is, so the keyboard, focus and screen reader come with it.
// A placement that couldn't load shows today's boxes with New box picked and
// an Alert with Retry; Send still works.
import React from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Header, ListBox, ListBoxItem, ListBoxSection, Meter, Text, type ListBoxProps } from '@launchpad-ui/components';
import type { Instance } from '../../types';
import { NEW_BOX } from './LaunchDrawer';
import {
  AUTO, autoLine, boxRowLine, defaultWords, meterPercent, meterTone, newBoxSourceWords,
  type PlacementBox, type PlacementView,
} from '../../chat/boxPlacement';

type Selection = Parameters<NonNullable<ListBoxProps<object>['onSelectionChange']>>[0];

/** A box the placement doesn't list yet (it loaded before the box came), drawn from the box list as a plain row. */
function rowFromInstance(b: Instance): PlacementBox {
  return {
    instanceId: b.id, name: b.name, status: b.status, connected: true, heat: 'unknown', heatReasons: [], load: null,
    sessions: b.projects?.length ?? 0, hasRepos: false, checkoutProjectId: null, lastUsedAt: null,
  };
}

export function PlacementPicker({ view, failed, onRetry, boxes, selection, onSelect, autoName, newBoxTitle, newBoxCold, repoWords, locked, wakingId }: {
  view: PlacementView | null;
  failed: boolean;
  onRetry: () => void;
  /** The boxes New session can launch on (LaunchDrawer launchableBoxes); the placement's rows win where it has one. */
  boxes: readonly Instance[];
  /** AUTO, NEW_BOX or a box's id: what the list shows picked. */
  selection: string;
  onSelect: (choice: string) => void;
  /** What Auto resolved to, for its line: a box's name or "New box"; null while the placement loads. */
  autoName: string | null;
  newBoxTitle: string;
  /** New box can't come from the pool (a bigger disk, a type of the repository's own): a launch, whatever the pool holds. */
  newBoxCold?: boolean;
  /** "has termag", for the rows of boxes that have the repository. */
  repoWords: string | null;
  /** The box is settled (one was launched for a refused start): nothing here can be picked. */
  locked?: boolean;
  wakingId: string | null;
}) {
  const byId = new Map((view?.boxes ?? []).map(b => [b.instanceId, b]));
  // The placement's order (up and cool first, hot last), then any box it didn't know about.
  const rows: PlacementBox[] = [
    ...(view?.boxes ?? []).filter(b => boxes.some(i => i.id === b.instanceId)),
    ...boxes.filter(b => !byId.has(b.id)).map(rowFromInstance),
  ].map(r => (wakingId === r.instanceId ? { ...r, status: 'starting' } : r));
  const auto = autoLine({ view, failed, name: autoName });
  const keys = [AUTO, ...rows.map(r => r.instanceId), NEW_BOX];
  // Auto with no placement to go on is New box, picked here and offered no further.
  const shown = failed && selection === AUTO ? NEW_BOX : selection;
  const onSelectionChange = (next: Selection) => {
    if (next === 'all') return;
    const [k] = [...next].map(String);
    if (k) onSelect(k);
  };
  return (
    <>
      {failed && (
        <Alert status="error" className="chat-placement-alert">
          <Text elementType="p">Couldn't check your boxes. New box is picked; Send still works.</Text>
          <Button size="small" onPress={onRetry}>Retry</Button>
        </Alert>
      )}
      <ListBox
        aria-label="Where this session runs"
        className="chat-placement-list"
        selectionMode="single"
        disallowEmptySelection
        escapeKeyBehavior="none"
        selectedKeys={[shown]}
        disabledKeys={locked ? keys.filter(k => k !== shown) : failed ? [AUTO] : []}
        onSelectionChange={onSelectionChange}
      >
        <ListBoxItem id={AUTO} textValue="Auto (recommended)" className="chat-placement-option">
          <Text slot="label" className="chat-placement-name">Auto <span className="chat-placement-recommended">(recommended)</span></Text>
          {auto && <Text slot="description" className="chat-placement-line">{auto}</Text>}
        </ListBoxItem>
        {rows.length > 0 && (
          <ListBoxSection id="boxes">
            <Header>Your boxes</Header>
            {rows.map(r => {
              const pct = meterPercent(r.load);
              return (
                <ListBoxItem key={r.instanceId} id={r.instanceId} textValue={r.name} className="chat-placement-option" data-heat={r.heat}>
                  <Text slot="label" className="chat-placement-name">{r.name}</Text>
                  <Text slot="description" className="chat-placement-line">{boxRowLine(r, repoWords)}</Text>
                  {pct !== null && (
                    <Meter className="chat-placement-meter" variant="bar" value={pct} maxValue={100} aria-label={`${r.name}'s load`} valueLabel={`${pct}% of running hot`} data-tone={meterTone(r)} />
                  )}
                </ListBoxItem>
              );
            })}
          </ListBoxSection>
        )}
        <ListBoxSection id="new-box">
          <ListBoxItem id={NEW_BOX} textValue={newBoxTitle} className="chat-placement-option">
            <Text slot="label" className="chat-placement-name">{newBoxTitle}</Text>
            <Text slot="description" className="chat-placement-line">{newBoxSourceWords(newBoxCold ? 'cold' : view?.newBox.source ?? 'cold')}</Text>
          </ListBoxItem>
        </ListBoxSection>
      </ListBox>
      {view && (
        <div className="chat-placement-default">
          {defaultWords(view.policy)} · <Link to="/settings#where-new-sessions-run">Change</Link>
        </div>
      )}
    </>
  );
}
