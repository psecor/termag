/**
 * The tools termag can update on a box: one
 * entry per component, which every route, the RPC sender, the report, the
 * preview and the fleet scope look up. A new tool needs an entry here, a
 * recipe on the box (deploy/termag-claude-update for Claude Code,
 * deploy/termag-codex-update for Codex, deploy/termag-cursor-update for the
 * Cursor agent, deploy/termag-devin-update for the Devin CLI,
 * deploy/termag-pi-update for pi, all on
 * deploy/termag-tool-update-lib; deploy/termag-gh-update for the GitHub CLI
 * and deploy/termag-aws-update for the AWS CLI v2, which run as root;
 * deploy/termag-node-update for Node),
 * its unit and its row in agent/tool-update.js, and a policy source; no
 * route, endpoint or migration.
 */
import { boolVariation, jsonVariation } from '../featureFlags';
import type { FlagBox, FlagUser } from '../featureFlags';
import {
  CLAUDE_UPDATE_ENABLED_FLAG, CLAUDE_UPDATE_POLICY_FLAG, isClaudeVersion, parseClaudeUpdatePolicy, type ClaudeUpdatePolicy,
} from '../claudeUpdatePolicy';
import { CODEX_UPDATE_ENABLED_FLAG, CODEX_UPDATE_POLICY_FLAG, parseCodexUpdatePolicy } from '../codexUpdatePolicy';
import { CURSOR_PINNED_LATEST, CURSOR_UPDATE_ENABLED_FLAG, CURSOR_UPDATE_POLICY_FLAG, isCursorVersion, parseCursorUpdatePolicy } from '../cursorUpdatePolicy';
import { DEVIN_UPDATE_ENABLED_FLAG, DEVIN_UPDATE_POLICY_FLAG, parseDevinUpdatePolicy } from '../devinUpdatePolicy';
import { PI_UPDATE_ENABLED_FLAG, PI_UPDATE_POLICY_FLAG, parsePiUpdatePolicy } from '../piUpdatePolicy';
import { GH_UPDATE_ENABLED_FLAG, GH_UPDATE_POLICY_FLAG, parseGhUpdatePolicy } from '../ghUpdatePolicy';
import { AWS_UPDATE_ENABLED_FLAG, AWS_UPDATE_POLICY_FLAG, parseAwsUpdatePolicy } from '../awsUpdatePolicy';
import { NODE_UPDATE_ENABLED_FLAG, NODE_UPDATE_POLICY_FLAG, parseNodeUpdatePolicy } from '../nodeUpdatePolicy';

export const TOOL_COMPONENTS = ['claude', 'codex', 'cursor', 'devin', 'pi', 'gh', 'aws', 'node'] as const;
export type ToolComponent = typeof TOOL_COMPONENTS[number];
export const isToolComponent = (v: unknown): v is ToolComponent => typeof v === 'string' && (TOOL_COMPONENTS as readonly string[]).includes(v);

/** What a run of any tool is told and how it restarts; Claude Code's policy is the shape every tool's takes. */
export type ToolUpdatePolicy = ClaudeUpdatePolicy;

export interface ToolDescriptor {
  component: ToolComponent;
  /** For log lines and messages. */
  displayName: string;
  /** Its `host_software` component name. */
  inventoryName: string;
  /**
   * The provider-registry ids whose agent panes run it: the preview counts
   * those panes, and a report relaunches only them (with the provider's
   * resumeCommand when the pane had a conversation).
   */
  providers: readonly string[];
  /** Its policy for the owner and the box (a user alone where there is no box). */
  policy(user: FlagUser, box: FlagBox | null): Promise<ToolUpdatePolicy>;
  /** Whether updating it is on for the owner and the box: off, the admin routes answer 404 and a run gets restart none. */
  enabled(user: FlagUser, box: FlagBox | null): Promise<boolean>;
  /** The cloud-session runner enforces its floor (claudeRunnerSpawn.ts). */
  runnerFloor: boolean;
  /**
   * What the box's agent announces once this tool's unit is loaded
   * (agent/tool-update.js): only such a box is sent a run of it. Claude Code's
   * is the contract's `tool-update-v1`; a later tool's names it, so an agent
   * that predates the tool, or whose box lacks its unit, is not capable.
   */
  capability: string;
  /** An exact version of it, the shape a policy's floor and target take (x.y.z; Cursor's is a dated build). */
  isVersion: (v: unknown) => v is string;
  /**
   * What a target that is not exact (latest) resolves to on the box, when the
   * box does not take it from the tool's channel: the Cursor agent's newest
   * pinned build. "Behind" then compares with it, not with the newest version
   * in the fleet (fleet.ts behindReference), and the preview names it as the
   * target.
   */
  latestReference?: string;
}

export const TOOL_REGISTRY: Record<ToolComponent, ToolDescriptor> = {
  claude: {
    component: 'claude',
    displayName: 'Claude Code',
    inventoryName: 'claude',
    providers: ['claude'],
    policy: async (user, box) => parseClaudeUpdatePolicy(await jsonVariation(CLAUDE_UPDATE_POLICY_FLAG, user, null, box)),
    enabled: (user, box) => boolVariation(CLAUDE_UPDATE_ENABLED_FLAG, user, false, box),
    runnerFloor: true,
    capability: 'tool-update-v1',
    isVersion: isClaudeVersion,
  },
  codex: {
    component: 'codex',
    displayName: 'Codex',
    inventoryName: 'codex',
    providers: ['codex'],
    policy: async (user, box) => parseCodexUpdatePolicy(await jsonVariation(CODEX_UPDATE_POLICY_FLAG, user, null, box)),
    enabled: (user, box) => boolVariation(CODEX_UPDATE_ENABLED_FLAG, user, false, box),
    runnerFloor: false,
    capability: 'tool-update-codex-v1',
    isVersion: isClaudeVersion,
  },
  cursor: {
    component: 'cursor',
    displayName: 'Cursor agent',
    inventoryName: 'cursor-agent',
    providers: ['cursor'],
    policy: async (user, box) => parseCursorUpdatePolicy(await jsonVariation(CURSOR_UPDATE_POLICY_FLAG, user, null, box)),
    enabled: (user, box) => boolVariation(CURSOR_UPDATE_ENABLED_FLAG, user, false, box),
    runnerFloor: false,
    capability: 'tool-update-cursor-v1',
    isVersion: isCursorVersion,
    latestReference: CURSOR_PINNED_LATEST,
  },
  devin: {
    component: 'devin',
    displayName: 'Devin CLI',
    inventoryName: 'devin',
    providers: ['devin'],
    policy: async (user, box) => parseDevinUpdatePolicy(await jsonVariation(DEVIN_UPDATE_POLICY_FLAG, user, null, box)),
    enabled: (user, box) => boolVariation(DEVIN_UPDATE_ENABLED_FLAG, user, false, box),
    runnerFloor: false,
    capability: 'tool-update-devin-v1',
    isVersion: isClaudeVersion,
  },
  pi: {
    component: 'pi',
    displayName: 'pi',
    inventoryName: 'pi',
    // pi is the pi provider's agent; its chat-runner twin
    // (pi-chat) has no panes, and relaunchReportedPanes skips it.
    providers: ['pi'],
    policy: async (user, box) => parsePiUpdatePolicy(await jsonVariation(PI_UPDATE_POLICY_FLAG, user, null, box)),
    enabled: (user, box) => boolVariation(PI_UPDATE_ENABLED_FLAG, user, false, box),
    runnerFloor: false,
    capability: 'tool-update-pi-v1',
    isVersion: isClaudeVersion,
  },
  gh: {
    component: 'gh',
    displayName: 'GitHub CLI',
    inventoryName: 'gh',
    // No sessions: a gh is a short command, and no provider runs one in a pane.
    providers: [],
    policy: async (user, box) => parseGhUpdatePolicy(await jsonVariation(GH_UPDATE_POLICY_FLAG, user, null, box)),
    enabled: (user, box) => boolVariation(GH_UPDATE_ENABLED_FLAG, user, false, box),
    runnerFloor: false,
    capability: 'tool-update-gh-v1',
    isVersion: isClaudeVersion,
  },
  aws: {
    component: 'aws',
    displayName: 'AWS CLI',
    inventoryName: 'aws',
    // No sessions: an aws is a short command, and no provider runs one in a pane.
    providers: [],
    policy: async (user, box) => parseAwsUpdatePolicy(await jsonVariation(AWS_UPDATE_POLICY_FLAG, user, null, box)),
    enabled: (user, box) => boolVariation(AWS_UPDATE_ENABLED_FLAG, user, false, box),
    runnerFloor: false,
    capability: 'tool-update-aws-v1',
    isVersion: isClaudeVersion,
  },
  node: {
    component: 'node',
    displayName: 'Node',
    inventoryName: 'node',
    // No pane is relaunched: this version restarts the agent only, and leaves
    // sessions on the old Node, which stays installed.
    providers: [],
    policy: async (user, box) => parseNodeUpdatePolicy(await jsonVariation(NODE_UPDATE_POLICY_FLAG, user, null, box)),
    enabled: (user, box) => boolVariation(NODE_UPDATE_ENABLED_FLAG, user, false, box),
    runnerFloor: false,
    capability: 'tool-update-node-v1',
    isVersion: isClaudeVersion,
  },
};

/** The descriptor for a component a caller named, or null for one termag does not update. */
export function toolDescriptor(component: unknown): ToolDescriptor | null {
  return isToolComponent(component) ? TOOL_REGISTRY[component] : null;
}

/** The answer for a component the registry does not list. */
export const UNKNOWN_COMPONENT = { code: 'unknown_component', error: `component must be one of ${TOOL_COMPONENTS.join(', ')}` } as const;
