// The What's new dialog (What people see): a tab for
// termag and one for lab, each listing its entries by week, newest first.
// It opens on the tab for the UI it was opened from, and showing a tab marks
// its entries seen. LaunchPad's modal, dialog and tabs, in termag's colours.
import React, { useEffect, useState } from 'react';
import { Dialog, Heading, IconButton, Modal, ModalOverlay, Tab, TabList, TabPanel, Tabs as LpTabs } from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { Markdown } from '../chat/Markdown';
import { ensureLaunchPadSprite } from '../launchpad/sprite';
import { LP_THEME } from '../launchpad/theme';
import { markSeen, type Tabs } from './useWhatsNew';
import { groupByWeek, localDay, unseenIds, WINDOW_DAYS } from './view';
import { SURFACES, type Category, type Surface, type WhatsNewEntry } from './whatsNew';


const CATEGORY_LABEL: Record<Category, string> = { new: 'New', changed: 'Changed', fixed: 'Fixed', removed: 'Removed' };

function Entry({ entry, fresh }: { entry: WhatsNewEntry; fresh: boolean }) {
  return (
    <li className="whats-new-entry" data-fresh={fresh || undefined}>
      <span className="whats-new-dot" aria-hidden="true" />
      {/* A label, not a control: LaunchPad has no badge or lozenge to use here. */}
      <span className="whats-new-category" data-category={entry.category}>{CATEGORY_LABEL[entry.category]}</span>
      <div className="whats-new-text">
        <Heading level={4} className="whats-new-title">
          {entry.title}
          {fresh && <span className="whats-new-visually-hidden"> (unseen)</span>}
        </Heading>
        <div className="whats-new-body"><Markdown text={entry.body} /></div>
      </div>
    </li>
  );
}

function TabBody({ surface, entries, fresh, today }: { surface: Surface; entries: WhatsNewEntry[]; fresh: ReadonlySet<string>; today: string }) {
  if (!entries.length) {
    return (
      <div className="whats-new-empty">
        {/* Plain paragraphs: inside a Dialog, LaunchPad's Text must take one of its slots. */}
        <p>Nothing new in {surface} in the last {WINDOW_DAYS} days.</p>
        <p className="whats-new-empty-sub">Changes show up here as they ship.</p>
      </div>
    );
  }
  return (
    <>
      {groupByWeek(entries, today).map(week => (
        <section key={week.start} className="whats-new-week" aria-label={week.label}>
          <Heading level={3} className="whats-new-week-label">{week.label}</Heading>
          <ul className="whats-new-list">
            {week.entries.map(e => <Entry key={e.id} entry={e} fresh={fresh.has(e.id)} />)}
          </ul>
        </section>
      ))}
    </>
  );
}

export default function WhatsNewDialog({ surface, tabs, seen, onClose }: {
  surface: Surface;
  tabs: Tabs;
  seen: ReadonlySet<string>;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Surface>(surface);
  // What was unseen when the dialog opened. Its dots and the tabs' counts hold
  // still while it stays open, though showing a tab marks its entries seen.
  const [fresh] = useState(() => new Set(SURFACES.flatMap(s => unseenIds(tabs[s], seen))));
  const today = localDay();

  useEffect(() => { void ensureLaunchPadSprite(); }, []);
  useEffect(() => { markSeen(tabs[tab].map(e => e.id)); }, [tab, tabs]);

  return (
    <ModalOverlay isOpen isDismissable onOpenChange={open => { if (!open) onClose(); }} className={`whats-new-layer ${LP_THEME}`}>
      <Modal size="medium" className="whats-new">
        <Dialog className="whats-new-dialog">
          <div className="whats-new-head">
            <Heading slot="title" level={2} size="medium">What's new</Heading>
            <IconButton icon="cancel" aria-label="Close" variant="minimal" size="small" onPress={onClose} />
          </div>
          <LpTabs className="whats-new-tabs" selectedKey={tab} onSelectionChange={key => setTab(key as Surface)}>
            <TabList aria-label="termag or lab" className="whats-new-tablist">
              {SURFACES.map(s => {
                const count = tabs[s].filter(e => fresh.has(e.id)).length;
                return (
                  <Tab key={s} id={s} className="whats-new-tab" data-surface={s}>
                    {s === 'lab' && <Icon name="flask" size="medium" aria-hidden="true" />}
                    {s}
                    {count > 0 && <span className="whats-new-count" aria-label={`${count} unseen`}>{count}</span>}
                  </Tab>
                );
              })}
            </TabList>
            {SURFACES.map(s => (
              <TabPanel key={s} id={s} className="whats-new-panel">
                <TabBody surface={s} entries={tabs[s]} fresh={fresh} today={today} />
              </TabPanel>
            ))}
          </LpTabs>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
