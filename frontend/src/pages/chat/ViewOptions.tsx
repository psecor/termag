// The sidebar's view options under the chrome refresh
// (chat/sidebarView.ts), beside Search, all
// LaunchPad: rows Compact or Standard, grouped by Space, Project or Status, and whether
// files and new tabs, and agents that aren't running, are shown.
import React from 'react';
import {
  Dialog, DialogTrigger, IconButton, Popover, Separator, Switch, ToggleButton, ToggleButtonGroup, Tooltip, TooltipTrigger,
} from '@launchpad-ui/components';
import { Icon, type IconName } from '@launchpad-ui/icons';
import { LP_THEME } from '../../launchpad/theme';
import { setSidebarView, useSidebarView } from '../../chat/sidebarView';

function Segment<K extends string>({ label, value, options, onChange }: {
  label: string;
  value: K;
  options: ReadonlyArray<[K, string, IconName]>;
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
          <ToggleButton key={id} id={id} size="small"><Icon name={icon} size="medium" aria-hidden="true" />{text}</ToggleButton>
        ))}
      </ToggleButtonGroup>
    </div>
  );
}

export function ViewOptions() {
  const view = useSidebarView();
  return (
    <DialogTrigger>
      <TooltipTrigger delay={300}>
        <IconButton icon="filter-tune" variant="minimal" aria-label="View options" className="chat-view-button" />
        <Tooltip placement="bottom" className={LP_THEME}>View options</Tooltip>
      </TooltipTrigger>
      <Popover placement="bottom start" className={`${LP_THEME} chat-view-popover`}>
        <Dialog aria-label="View options" className="chat-view-dialog">
          <Segment label="Rows" value={view.density}
            options={[['compact', 'Compact', 'list'], ['standard', 'Standard', 'layout-stack']]}
            onChange={density => setSidebarView({ density })} />
          <Segment label="Group by" value={view.groupBy}
            options={[['space', 'Space', 'folders'], ['project', 'Project', 'code'], ['status', 'Status', 'progress-check']]}
            onChange={groupBy => setSidebarView({ groupBy })} />
          <Separator className="chat-view-sep" />
          <Switch isSelected={view.showFiles} onChange={showFiles => setSidebarView({ showFiles })} className="chat-view-switch">
            Files and new tabs
          </Switch>
          <Switch isSelected={view.showIdle} onChange={showIdle => setSidebarView({ showIdle })} className="chat-view-switch">
            Sessions that aren't running
          </Switch>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
