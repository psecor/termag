import { useEffect } from 'react';
import { Button, Disclosure, DisclosurePanel } from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { LP_THEME } from '../../launchpad/theme';
import { ensureLaunchPadSprite } from '../../launchpad/sprite';

/**
 * What an OAuth connector may do, on its Settings → MCP servers row: one line,
 * "88 permissions" (or "88 permissions requested" when the server didn't say
 * what it granted), a LaunchPad Disclosure that lists each scope's label when opened.
 * The labels are mcp-oauth-scope-labels' where it has one, else the scope.
 */
export function McpPermissions({ granted, labels }: { granted: boolean; labels: string[] }) {
  useEffect(() => { void ensureLaunchPadSprite(); }, []);
  const count = `${labels.length} ${labels.length === 1 ? 'permission' : 'permissions'}`;
  return (
    <Disclosure className={`${LP_THEME} mcp-permissions`}>
      {({ isExpanded }) => (
        <>
          <Button slot="trigger" variant="minimal" size="small" className="mcp-permissions-trigger">
            <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size="small" />
            {granted ? count : `${count} requested`}
          </Button>
          <DisclosurePanel>
            <ul className="mcp-permission-list">
              {labels.map(l => <li key={l}>{l}</li>)}
            </ul>
          </DisclosurePanel>
        </>
      )}
    </Disclosure>
  );
}
