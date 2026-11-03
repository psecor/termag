// The chrome refresh's Stop: termag's one
// round button in place of the split one. A click stops. While background
// commands run it opens a menu instead, since a stop either keeps them or
// ends them: Stop Claude, or Stop Claude and background tasks
// (chat/sdkChat.ts stopChoices). Its state is useSdkChat's, so Escape does
// the same as a click.
import { Button, Menu, MenuItem, MenuTrigger, Popover, Text, Tooltip, TooltipTrigger } from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { LP_THEME } from '../../launchpad/theme';
import { StopIcon } from '../../chat/ComposerIcons';
import type { SdkChat } from './useSdkChat';

export function ComposerStop({ s }: { s: SdkChat }) {
  const { stopChoices: choices, stopMenu, setStopMenu, pressStop, stop } = s;
  const asks = choices.length > 0;
  const button = (
    <TooltipTrigger delay={300}>
      <Button variant="minimal" className="chat-stop-btn" aria-label="Stop" onPress={asks ? undefined : pressStop}>
        <StopIcon />
      </Button>
      <Tooltip placement="top" className={LP_THEME}>{asks ? 'Stop… (Esc)' : 'Stop (Esc)'}</Tooltip>
    </TooltipTrigger>
  );
  if (!asks) return button;
  return (
    <MenuTrigger isOpen={stopMenu} onOpenChange={setStopMenu}>
      {button}
      <Popover placement="top end" className={`${LP_THEME} chat-menu-popover chat-stop-popover`}>
        <Menu aria-label="Stop" onAction={key => stop(key === 'turn' ? 'turn' : 'all')}>
          {choices.map(c => (
            <MenuItem key={c.scope} id={c.scope} textValue={c.label} className={c.scope === 'all' ? 'chat-stop-all' : undefined}>
              <Icon name={c.scope === 'turn' ? 'stop-circle-outline' : 'cancel-circle-outline'} size="medium" aria-hidden="true" />
              <Text slot="label">{c.label}</Text>
              <Text slot="description">{c.hint}</Text>
            </MenuItem>
          ))}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}
