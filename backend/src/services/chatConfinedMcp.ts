/**
 * Broker connectors in confined chat turns ("Confined chat
 * turns"; agent/broker-mcp.js). A dontAsk or auto turn runs with an empty
 * strict MCP config; on an agent with chat-confined-mcp-v1, and with
 * chat-confined-mcp-enabled on for the box's owner, a send tells the box which
 * of the owner's connectors the turn may reach (`brokerMcp`):
 *
 * - the owner's own turn: their connectors through this orchestrator's broker,
 *   with a reviewed allowlist of read tools (dontAsk refuses every other MCP
 *   call; auto hands it to its classifier), whatever the mode asked, since
 *   the box settles the mode from the checkout. An automation's turns (its
 *   runs and their follow-ups) only when everything the run produces stays
 *   with the owner (automationStaysWithOwner): a run steered by text in the
 *   repo or its space could otherwise summarise the owner's private Slack or
 *   Jira for whoever reads its log, its chat or its Slack report;
 * - anyone else's turn on the owner's box (a sharee's): none, which also
 *   takes them out of a bypassPermissions turn.
 *
 * No field (flag off, an older agent, an ask's turn) is what the turn got
 * before: confined turns load no MCP server, bypass turns load the box's own.
 */
import { prisma } from '../db';
import { boolVariationOrUnknown } from './featureFlags';
import type { FlagBox, FlagUser } from './featureFlags';
import { catalogForUser, listConnectors } from './mcpConnectorStore';
import { getMcpBrokerUrl } from './mcpConnectors';

export const CHAT_CONFINED_MCP_CAPABILITY = 'chat-confined-mcp-v1';
export const CHAT_CONFINED_MCP_FLAG = 'chat-confined-mcp-enabled';

interface CatalogTools {
  /** Tool names, or a trailing-* prefix of them (a Claude Code permission rule). */
  allow: readonly string[];
  /** Reads an allow prefix lets in that a turn may still not make. */
  deny?: readonly string[];
}

/**
 * The tools of a catalog server a confined turn may call unasked, by the
 * catalog entry's name (the mcp-default-connectors flag), the user's
 * connector matched to it by URL as Settings matches them. Reads only, so a
 * dontAsk turn ("Read only") stays read-only. A server not listed here, a
 * connector added by hand included, gets no rule: none of its tools in
 * dontAsk, every call to the classifier in auto. Atlassian's
 * discover/executeRead are left out: they run any operation the server names.
 */
export const CATALOG_READ_TOOLS: Readonly<Record<string, CatalogTools>> = {
  atlassian: { allow: ['get*', 'search*', 'list*', 'lookup*', 'fetch', 'atlassianUserInfo'] },
  slack: { allow: ['slack_search_*', 'slack_read_*', 'slack_list_*', 'slack_get_reactions'] },
};

export type BrokerMcp =
  | { connectors: 'owner'; broker: string; allow: string[]; deny: string[] }
  // The broker lets the box deny every ~/.claude.json server on it, whatever its record says (agent/broker-mcp.js).
  | { connectors: 'none'; broker?: string };

/** The --allowedTools and --disallowedTools rules for a user's connectors: each catalog one's reads, under its own name. */
export function readToolRules(
  connectors: ReadonlyArray<{ name: string; upstream: string }>,
  catalog: ReadonlyArray<{ name: string; upstream: string }>,
): { allow: string[]; deny: string[] } {
  const allow: string[] = [];
  const deny: string[] = [];
  for (const c of connectors) {
    const entry = catalog.find(d => d.upstream === c.upstream);
    const tools = entry && Object.prototype.hasOwnProperty.call(CATALOG_READ_TOOLS, entry.name) ? CATALOG_READ_TOOLS[entry.name] : null;
    if (!tools) continue;
    allow.push(...tools.allow.map(t => `mcp__${c.name}__${t}`));
    deny.push(...(tools.deny ?? []).map(t => `mcp__${c.name}__${t}`));
  }
  return { allow, deny };
}

export interface BrokerMcpTarget {
  /** The chat's project and workstream: an automation's run, for one (automationStaysWithOwner). */
  projectId: string;
  workstreamId: string | null;
  isOwner: boolean;
  /** The project's owner, whose box it is. */
  ownerId: string;
  instanceId: string | null;
  agentCapabilities: readonly string[];
  /** An ask's chat: never (its turns are the ask runner's). */
  ask?: unknown;
  engine?: 'claude' | 'pi' | null;
}

export interface BrokerMcpDeps {
  /** chat-confined-mcp-enabled for the owner and box; null when the flag source could not answer. */
  flagOn: (user: FlagUser, box: FlagBox) => Promise<boolean | null>;
  owner: (ownerId: string, instanceId: string) => Promise<{ user: FlagUser; box: FlagBox } | null>;
  broker: () => string | null;
  connectors: (ownerId: string) => Promise<ReadonlyArray<{ name: string; upstream: string }>>;
  catalog: (user: FlagUser) => Promise<ReadonlyArray<{ name: string; upstream: string }>>;
  /** Where an automation's turn in this workstream sends what it produces, or null when the project is not an automation. */
  automation: (projectId: string, workstreamId: string | null) => Promise<AutomationOutputs | null>;
  /** Who besides its members may read a space's files, or null when there is no such live space. */
  spaceReaders: (spaceName: string) => Promise<SpaceReaders | null>;
}

export interface AutomationOutputs {
  /**
   * Every space the turn's output can land in: the automation's (its folder
   * holds the run's notes, logs and outputs) and the run chat's own, which is
   * fixed when the chat starts and stays put when the automation moves (Devin
   * Review, #1433). Empty with neither.
   */
  spaceNames: readonly string[];
  /** Each finished run's report goes to the project's Slack channel (Automation.notifySlack). */
  notifySlack: boolean;
  /** The turn's workstream has a Slack channel (its own, or the project's for main), or it could not be told. */
  workstreamSlack: boolean;
  /** People the project is shared with, or have a pending invitation to it: they read its chats. */
  projectSharees: number;
}

export interface SpaceReaders {
  memberIds: readonly string[];
  /** Invitations not yet taken up: people about to be members. */
  pendingInvites: number;
  /** The space's own Slack: its channel reads what the space's runs post. */
  slackLinked: boolean;
  /** Files shared by link (SpaceFileShare), which any signed-in user can read: a run may write into one. */
  fileShares: number;
}

/**
 * Whether an automation's turns may have the owner's connectors: only when
 * everything its run produces stays with the owner. No Slack output (the run
 * report off, no Slack channel on the run's workstream), the project shared
 * with nobody, and every space it touches a private one of the owner's
 * (none at all is fine): live, the owner its only member, no invitation
 * waiting, no space Slack linked, no file shared by link. Anything else, a
 * lookup that fails included (it throws to the caller), is not.
 */
export async function automationStaysWithOwner(outputs: AutomationOutputs, ownerId: string, spaceReaders: BrokerMcpDeps['spaceReaders']): Promise<boolean> {
  if (outputs.notifySlack || outputs.workstreamSlack || outputs.projectSharees > 0) return false;
  for (const name of new Set(outputs.spaceNames)) {
    if (!privateToOwner(await spaceReaders(name), ownerId)) return false;
  }
  return true;
}

function privateToOwner(readers: SpaceReaders | null, ownerId: string): boolean {
  if (!readers || readers.pendingInvites > 0 || readers.slackLinked || readers.fileShares > 0) return false;
  return readers.memberIds.length > 0 && readers.memberIds.every(id => id === ownerId);
}

const LD_USER_SELECT = { id: true, googleEmail: true, displayName: true, unixUsername: true, defaultAgentProvider: true } as const;

const defaultDeps: BrokerMcpDeps = {
  flagOn: (user, box) => boolVariationOrUnknown(CHAT_CONFINED_MCP_FLAG, user, false, box),
  owner: async (ownerId, instanceId) => {
    const [user, box] = await Promise.all([
      prisma.user.findUnique({ where: { id: ownerId }, select: LD_USER_SELECT }),
      prisma.instance.findUnique({ where: { id: instanceId }, select: { id: true, name: true, kind: true } }),
    ]);
    return user && box ? { user, box } : null;
  },
  broker: () => getMcpBrokerUrl(),
  connectors: ownerId => listConnectors(ownerId),
  catalog: user => catalogForUser(user),
  automation: (projectId, workstreamId) => automationOutputsOf(projectId, workstreamId),
  spaceReaders: name => spaceReadersOf(name),
};

/** BrokerMcpDeps.automation from the database: null when the project is not an automation. */
export async function automationOutputsOf(projectId: string, workstreamId: string | null): Promise<AutomationOutputs | null> {
  const a = await prisma.automation.findUnique({
    where: { projectId },
    // Pending invites only: an accepted or declined one stays as a row (Bugbot, #1433); an accepted one that still counts is a share.
    select: { spaceName: true, notifySlack: true, project: { select: { slackChannelId: true, _count: { select: { shares: true, invites: { where: { status: 'pending' } } } } } } },
  });
  if (!a) return null;
  const ws = workstreamId
    ? await prisma.workstream.findUnique({ where: { id: workstreamId }, select: { projectId: true, name: true, slackChannelId: true, spaceId: true, space: { select: { name: true } } } })
    : null;
  // A workstream that can't be found, or isn't this project's, counts as one with Slack: fail closed.
  const workstreamSlack = !ws || ws.projectId !== projectId || ws.slackChannelId != null || (ws.name === 'main' && a.project.slackChannelId != null);
  // The chat's own space too. One whose row can't be read is a lookup that failed: brokerMcpFor sends nothing.
  const chatSpace = ws?.spaceId ? ws.space?.name ?? null : null;
  if (ws?.spaceId && !chatSpace) throw new Error(`the space of workstream ${workstreamId} could not be read`);
  const spaceNames = [a.spaceName, chatSpace].filter((n): n is string => typeof n === 'string');
  return { spaceNames, notifySlack: a.notifySlack, workstreamSlack, projectSharees: a.project._count.shares + a.project._count.invites };
}

/** BrokerMcpDeps.spaceReaders from the database: null when there is no such live space. */
export async function spaceReadersOf(name: string): Promise<SpaceReaders | null> {
  const space = await prisma.space.findUnique({
    where: { name },
    select: { deletedAt: true, members: { select: { userId: true } }, _count: { select: { invites: true, fileShares: true } }, slack: { select: { id: true } } },
  });
  if (!space || space.deletedAt) return null;
  return { memberIds: space.members.map(m => m.userId), pendingInvites: space._count.invites, slackLinked: space.slack != null, fileShares: space._count.fileShares };
}

/**
 * What a chat-send or chat-resume-claim carries as `brokerMcp`, or null for
 * nothing. A read that fails, or a flag the flag source could not answer, is
 * nothing for the owner (their turn runs as it did before this) and "none"
 * for anyone else: a sharee's bypass turn must not get the owner's
 * connectors back because a lookup failed (Devin Review, #1431).
 */
export async function brokerMcpFor(target: BrokerMcpTarget, deps: BrokerMcpDeps = defaultDeps): Promise<BrokerMcp | null> {
  if (target.ask || !target.instanceId || !target.agentCapabilities.includes(CHAT_CONFINED_MCP_CAPABILITY)) return null;
  const none = (): BrokerMcp | null => {
    if (target.isOwner) return null;
    const broker = deps.broker();
    return broker ? { connectors: 'none', broker } : { connectors: 'none' };
  };
  try {
    const owner = await deps.owner(target.ownerId, target.instanceId);
    if (!owner) return none();
    const on = await deps.flagOn(owner.user, owner.box);
    if (on === null) return none();
    if (!on) return null;
    if (!target.isOwner) return none();
    const broker = deps.broker();
    // A pi turn takes only "none": its confined turns load no MCP, and its bypass turns load the owner's own.
    if (target.engine === 'pi' || !broker) return null;
    // An automation's run or follow-up: only when all it produces stays with the owner. A lookup that fails is caught below: nothing.
    const automation = await deps.automation(target.projectId, target.workstreamId);
    if (automation && !await automationStaysWithOwner(automation, target.ownerId, deps.spaceReaders)) return null;
    const [connectors, catalog] = await Promise.all([deps.connectors(target.ownerId), deps.catalog(owner.user)]);
    return { connectors: 'owner', broker, ...readToolRules(connectors, catalog) };
  } catch (err) {
    console.warn('[CHAT] broker connectors for a turn unreadable; it loads none of them:', (err as Error).message);
    return none();
  }
}
