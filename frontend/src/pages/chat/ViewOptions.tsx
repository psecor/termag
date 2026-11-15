// The sidebar's view options under the chrome refresh
// (chat/sidebarView.ts), beside Search, all
// LaunchPad: show the tabs or every session (Projects),
// rows Compact or Standard,
// the tabs grouped by Space, Project or Status, and whether files and new
// tabs, and agents that aren't running, are shown. Projects has its own fixed
// grouping, so Group by is hidden under it. Space stays among the groupings
// until milestone 8 retires spaces.
// Under user-projects-enabled there's no Show:
// Group by orders the one list, Sort says how (Created, the list's own order,
// or Recent activity, chat/sidebarSort.ts), and Move to Older after says when a
// session you haven't touched moves to Older: after 1, 3 or 7 days, or never. Files and new tabs aren't in its
// sidebar (they're the side panel's Files, FilesTool.tsx), so there's no switch for them.
import React from 'react';
import {
  Dialog, DialogTrigger, IconButton, Popover, Separator, Switch, ToggleButton, ToggleButtonGroup, Tooltip, TooltipTrigger,
} from '@launchpad-ui/components';
import { Icon, type IconName } from '@launchpad-ui/icons';
import { LP_THEME } from '../../launchpad/theme';
import { setSidebarView, sidebarGroupings, useSidebarView, type SidebarGroupBy } from '../../chat/sidebarView';
import { OLDER_DAYS, type OlderDays } from '../../chat/sidebarLayout';
import { SIDEBAR_SORTS, type SidebarSort } from '../../chat/sidebarSort';
import { FLAGS, useFlag } from '../../flags';

const GROUPINGS: Record<SidebarGroupBy, [string, IconName]> = {
  space: ['Space', 'folders'],
  project: ['Project', 'code'],
  status: ['Status', 'progress-check'],
};

function Segment<K extends string>({ label, value, options, onChange }: {
  label: string;
  value: K;
  options: ReadonlyArray<[K, string, IconName?]>;
  onChange: (value: K) => void;
}) {
  return (
    <div className="chat-view-field">
      <span className="chat-view-label" aria-hidden="true">{label}</span>
      <ToggleButtonGroup
        aria-label={label}
        appearance="elevated"
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={new Set([value])}
        onSelectionChange={keys => { const v = [...keys][0] as K | undefined; if (v) onChange(v); }}
        className="chat-view-segment"
      >
        {options.map(([id, text, icon]) => (
          <ToggleButton key={id} id={id} size="small">{icon && <Icon name={icon} size="medium" aria-hidden="true" />}{text}</ToggleButton>
        ))}
      </ToggleButtonGroup>
    </div>
  );
}

const OLDER_WORDS: Record<OlderDays, string> = { 1: '1 day', 3: '3 days', 7: '7 days', 0: 'Never' };
/** Created: newest session first, as the list has always been. Recent activity: each session by its own. */
const SORTS: Record<SidebarSort, [string, IconName]> = { created: ['Created', 'calendar'], recent: ['Recent activity', 'clock'] };

export function ViewOptions() {
  const view = useSidebarView();
  const redesign = useFlag(FLAGS.userProjects, false);
  // No Group by Space under project-files-enabled: spaces hold files there.
  const groupings = sidebarGroupings(redesign, useFlag(FLAGS.projectFiles, false));
  return (
    <DialogTrigger>
      <TooltipTrigger delay={300}>
        <IconButton icon="filter-tune" variant="minimal" aria-label="View options" className="chat-view-button" />
        <Tooltip placement="bottom" className={LP_THEME}>View options</Tooltip>
      </TooltipTrigger>
      <Popover placement="bottom start" className={`${LP_THEME} chat-view-popover`}>
        <Dialog aria-label="View options" className="chat-view-dialog">
          {/* The redesign has one list, every session, so nothing to show instead. */}
          {!redesign && (
            <Segment label="Show" value={view.show}
              options={[['tabs', 'Tabs', 'layout-side-by-side'], ['projects', 'Projects', 'layout-structured']]}
              onChange={show => setSidebarView({ show })} />
          )}
          <Segment label="Rows" value={view.density}
            options={[['compact', 'Compact', 'list'], ['standard', 'Standard', 'layout-stack']]}
            onChange={density => setSidebarView({ density })} />
          {(view.show === 'tabs' || redesign) && (
            <Segment label="Group by" value={view.groupBy}
              options={groupings.map(g => [g, ...GROUPINGS[g]] as [SidebarGroupBy, string, IconName])}
              onChange={groupBy => setSidebarView({ groupBy })} />
          )}
          {redesign && (
            <Segment label="Sort" value={view.sort}
              options={SIDEBAR_SORTS.map(x => [x, ...SORTS[x]] as [SidebarSort, string, IconName])}
              onChange={sort => setSidebarView({ sort })} />
          )}
          {redesign && (
            <Segment label="Move to Older after" value={String(view.olderDays)}
              options={OLDER_DAYS.map(d => [String(d), OLDER_WORDS[d]] as [string, string])}
              onChange={d => setSidebarView({ olderDays: Number(d) as OlderDays })} />
          )}
          <Separator className="chat-view-sep" />
          {/* The redesign's files are the side panel's Files (FilesTool.tsx), not the sidebar's. */}
          {!redesign && (
            <Switch isSelected={view.showFiles} onChange={showFiles => setSidebarView({ showFiles })} className="chat-view-switch">
              Files and new tabs
            </Switch>
          )}
          <Switch isSelected={view.showIdle} onChange={showIdle => setSidebarView({ showIdle })} className="chat-view-switch">
            Sessions that aren't running
          </Switch>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
