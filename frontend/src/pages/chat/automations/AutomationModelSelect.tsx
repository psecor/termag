// The model an automation's next run starts on, on its page
// (AutomationDetail.tsx): LaunchPad's Select, as the box dialog's size field
// (components/BoxSizePicker.tsx), with New session's options
// (chat/useChatModelOptions.ts): Claude's tiers, then the owner's Fireworks
// models under their own heading. Not New session's ModelPicker, which is a
// composer pill with an effort slider that automations do not take. A pick is
// saved at once (utils/automationModel.ts); a run already going keeps the
// model it started on.
import React, { useEffect } from 'react';
import { Button, Header, ListBox, ListBoxItem, ListBoxSection, Popover, Select, SelectValue } from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { LP_THEME } from '../../../launchpad/theme';
import { ensureLaunchPadSprite } from '../../../launchpad/sprite';
import { useChatModelOptions } from '../../../chat/useChatModelOptions';
import type { ChatModelId } from '../../../chat/composer';
import { automationModelOptions } from '../../../utils/automationModel';

export function AutomationModelSelect({ value, onPick, disabled }: {
  value: ChatModelId;
  /** The pick, and its words for the notice. */
  onPick: (id: ChatModelId, label: string) => void;
  disabled?: boolean;
}) {
  useEffect(() => { void ensureLaunchPadSprite(); }, []);
  const options = automationModelOptions(value, useChatModelOptions());
  const claude = options.filter(o => !o.fireworks);
  const fireworks = options.filter(o => o.fireworks);
  return (
    <Select
      aria-label="Model"
      className={`${LP_THEME} chat-auto-model`}
      selectedKey={value}
      onSelectionChange={key => {
        const picked = options.find(o => o.id === String(key));
        if (picked && picked.id !== value) onPick(picked.id, picked.label);
      }}
      isDisabled={disabled}
    >
      <Button className="chat-auto-model-button">
        <SelectValue />
        <Icon name="chevron-down" size="small" />
      </Button>
      <Popover className={`${LP_THEME} chat-auto-model-popover`} placement="bottom start">
        <ListBox>
          <ListBoxSection id="claude">
            <Header className="chat-auto-model-head">Claude</Header>
            {claude.map(o => <ListBoxItem key={o.id} id={o.id} textValue={o.label}>{o.label}</ListBoxItem>)}
          </ListBoxSection>
          {fireworks.length > 0 && (
            <ListBoxSection id="fireworks">
              <Header className="chat-auto-model-head">Fireworks</Header>
              {fireworks.map(o => <ListBoxItem key={o.id} id={o.id} textValue={o.label}>{o.label}</ListBoxItem>)}
            </ListBoxSection>
          )}
        </ListBox>
      </Popover>
    </Select>
  );
}
