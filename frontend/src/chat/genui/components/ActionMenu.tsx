// A menu of actions behind one button: LaunchPad's MenuTrigger and Menu.
// Choosing an item sends it the way a Table row's button does (kit.tsx
// ChoicePress): the item, not the binding's params, is the answer's value,
// and a destructive one is confirmed first (GenUiSurface.tsx).
import React, { useContext } from 'react';
import { Button, IconButton, Menu, MenuItem, MenuTrigger, Popover, Text } from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { z } from 'zod';
import { ChoicePressContext, LAYER, SurfaceLocked } from '../kit';
import { defineGenUiComponent } from './index';
import './ActionMenu.css';

const item = z.object({
  id: z.string().min(1).max(100),
  label: z.string().min(1).max(80),
  description: z.string().max(200).optional(),
  variant: z.enum(['default', 'destructive']).optional(),
});

export default defineGenUiComponent({
  name: 'ActionMenu',
  props: z.object({
    label: z.string().min(1).max(60),
    trigger: z.enum(['button', 'more']).optional(),
    items: z.array(item).min(1).max(12).refine(items => new Set(items.map(i => i.id)).size === items.length, { message: 'item ids must differ' }),
  }),
  events: ['select'],
  sends: 'select',
  carriesChoice: true,
  description: 'A button that opens a menu of actions, for a few actions on one thing where a row of buttons would crowd (an overflow menu). trigger "button" (default) shows label on a button; "more" is a ⋯ icon button with label as its name. Choosing an item fires select; bind it to choose and the chosen item\'s id is sent as value, with its label. variant "destructive" for an item that deletes or can\'t be undone: the person confirms it first.',
  Component: ({ props, emit, on }) => {
    const locked = useContext(SurfaceLocked);
    const pressRef = useContext(ChoicePressContext);
    const choose = (key: React.Key) => {
      const chosen = props.items.find(i => i.id === String(key));
      if (!chosen || !pressRef || !on('select').bound) return;
      pressRef.current = { action: chosen.id, label: chosen.label, destructive: chosen.variant === 'destructive' };
      emit('select');
    };
    return (
      <MenuTrigger>
        {props.trigger === 'more'
          ? <IconButton icon="more-horiz" aria-label={props.label} variant="minimal" size="small" isDisabled={locked} />
          : <Button isDisabled={locked} className="genui-action-menu-button">{props.label}<Icon name="chevron-down" size="small" /></Button>}
        <Popover className={`${LAYER} genui-action-menu-popover`} placement="bottom end">
          <Menu onAction={choose} items={props.items} aria-label={props.label}>
            {it => (
              <MenuItem id={it.id} textValue={it.label} variant={it.variant ?? 'default'}>
                <Text slot="label">{it.label}</Text>
                {it.description && <Text slot="description" size="small">{it.description}</Text>}
              </MenuItem>
            )}
          </Menu>
        </Popover>
      </MenuTrigger>
    );
  },
});
