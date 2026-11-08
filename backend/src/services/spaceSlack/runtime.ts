/**
 * The link service's production wiring: Postgres stores, the Slack app's
 * client, space-channels-enabled and space-slack-limits read as flags.
 * Entry points (M5b's `/t link`, M5c's shortcut and App Home, M6's routes and
 * CLI) call `link(spaceSlackLinkDeps(), …)`.
 */
import { getSlackApp } from '../../slack/app';
import { prismaSpaceStore } from '../spaces/spaceStorePrisma';
import { spaceChannelsEnabledFor } from '../spaces/spacesRuntime';
import { DEFAULT_SPACE_SLACK_LIMITS, spaceSlackLimitsFor } from './limits';
import type { LinkDeps, LinkSlackClient } from './link';
import { prismaSpaceSlackStore } from './linkStore';
import { prismaThreadFreezer } from './threadFreezer';

export function spaceSlackLinkDeps(opts: { botUserId?: string } = {}): LinkDeps {
  return {
    spaces: prismaSpaceStore,
    store: prismaSpaceSlackStore,
    slack: (getSlackApp()?.client as LinkSlackClient | undefined) ?? null,
    channelsEnabled: spaceChannelsEnabledFor,
    async limitsFor(runnerUserId, overrides) {
      const runner = await prismaSpaceStore.ldUser(runnerUserId);
      return runner ? spaceSlackLimitsFor(runner, overrides) : DEFAULT_SPACE_SLACK_LIMITS;
    },
    botUserId: opts.botUserId,
    freezer: prismaThreadFreezer,
  };
}
