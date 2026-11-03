// LaunchPad's EmptyState: an icon in a badge, a title and a line under it,
// with the spec's children (usually Buttons) below as its actions.
import React from 'react';
import { z } from 'zod';
import { ButtonGroup, ButtonGroupContext, EmptyState, Heading, Text } from '@launchpad-ui/components';
import { BadgeIcon, Icon, type IconName } from '@launchpad-ui/icons';
import { defineGenUiComponent } from './index';
import './EmptyState.css';

/** The icons a spec may name: a short list the agent can choose from, each in LaunchPad's sprite (the type checks it). */
export const EMPTY_STATE_ICONS = [
  'search', 'inbox', 'check-circle', 'info-circle', 'warning', 'flag', 'folders', 'file', 'chat-bubble',
  'notifications', 'calendar', 'clock', 'filter', 'rocket', 'sparkles', 'terminal', 'bug', 'chart-line',
] as const satisfies readonly IconName[];

const props = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  icon: z.enum(EMPTY_STATE_ICONS).optional(),
});

export default defineGenUiComponent({
  name: 'EmptyState',
  props,
  slots: ['default'],
  description: 'What to show when there is nothing to show (no results, no open PRs, no alerts): a title, a description of why or what to do next, and an optional icon above them. Its children, usually one or two Buttons, go under it as its actions; use an Alert instead for something that needs attention.',
  Component: ({ props: p, children }) => (
    // size null: no page-sized padding inside a chat card (EmptyState.css pads it).
    <EmptyState size={null} className="genui-emptystate">
      {p.icon && <BadgeIcon size="medium"><Icon name={p.icon} /></BadgeIcon>}
      <Heading level={5}>{p.title}</Heading>
      {p.description && <Text elementType="p">{p.description}</Text>}
      {React.Children.count(children) > 0 && (
        <ButtonGroup className="genui-emptystate-actions">
          {/* The actions' place is for this group alone, not for a ButtonGroup the spec puts inside it. */}
          <ButtonGroupContext.Provider value={null}>{children}</ButtonGroupContext.Provider>
        </ButtonGroup>
      )}
    </EmptyState>
  ),
});
