// A turn the box ran read-only although the chat asked for full tools (agent
// chat-runner.js settleTurnMode): why, and what gives the tools back. A
// LaunchPad Alert under the person's message, so it is not mistaken for the
// model's own account of missing tools.
import { useEffect } from 'react';
import { Alert, Heading, Text } from '@launchpad-ui/components';
import { ensureLaunchPadSprite } from '../../launchpad/sprite';
import { LP_THEME } from '../../launchpad/theme';

/** Text with its `code` spans (the commands in a fix) as <code>, the rest as it is. */
function withCode(text: string) {
  return text.split(/(`[^`]+`)/).map((part, i) => (/^`[^`]+`$/.test(part) ? <code key={i}>{part.slice(1, -1)}</code> : part));
}

export function ReadOnlyTurnNotice({ reason, fix }: { reason: string; fix?: string }) {
  useEffect(() => { void ensureLaunchPadSprite(); }, []);
  return (
    <div className={`${LP_THEME} sdk-readonly`}>
      <Alert status="warning">
        <Heading level={4}>This turn is read-only</Heading>
        <Text elementType="p">
          Claude has only Read, Grep and Glob this turn: no shell, no edits, no MCP servers. The box refused full tools because {withCode(reason)}.
        </Text>
        {fix
          ? <Text elementType="p">To get them back, in a terminal on the box, {withCode(fix)}. The next message then runs with every tool.</Text>
          : <Text elementType="p">That is on purpose for this checkout, so its turns stay read-only.</Text>}
      </Alert>
    </div>
  );
}
