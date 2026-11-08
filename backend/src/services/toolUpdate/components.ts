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
 * deploy/termag-node-update for Node; deploy/termag-python-update for Python;
 * deploy/termag-docker-update for Docker, at the box's start only),
 * its unit and its row in agent/tool-update.js, and a policy source; no
 * route, endpoint or migration.
 */
import { jsonVariation } from '../featureFlags';
import type { FlagBox, FlagUser } from '../featureFlags';
import type { JsonFlagKey } from '../../flags';
import { modeAuto, modeEnabled } from './gate';
import {
  CLAUDE_UPDATE_POLICY_FLAG, isClaudeVersion, parseClaudeUpdatePolicy, type ClaudeUpdatePolicy,
} from '../claudeUpdatePolicy';
import { CODEX_UPDATE_POLICY_FLAG, parseCodexUpdatePolicy } from '../codexUpdatePolicy';
import { CURSOR_PINNED_LATEST, CURSOR_UPDATE_POLICY_FLAG, isCursorVersion, parseCursorUpdatePolicy } from '../cursorUpdatePolicy';
import { DEVIN_UPDATE_POLICY_FLAG, parseDevinUpdatePolicy } from '../devinUpdatePolicy';
import { PI_PINNED_LATEST, PI_UPDATE_POLICY_FLAG, parsePiUpdatePolicy } from '../piUpdatePolicy';
import { GH_UPDATE_POLICY_FLAG, parseGhUpdatePolicy } from '../ghUpdatePolicy';
import { AWS_UPDATE_POLICY_FLAG, parseAwsUpdatePolicy } from '../awsUpdatePolicy';
import { NODE_UPDATE_POLICY_FLAG, parseNodeUpdatePolicy } from '../nodeUpdatePolicy';
import { DOCKER_UPDATE_POLICY_FLAG, parseDockerUpdatePolicy } from '../dockerUpdatePolicy';
import { PYTHON_UPDATE_POLICY_FLAG, parsePythonUpdatePolicy } from '../pythonUpdatePolicy';

export const TOOL_COMPONENTS = ['claude', 'codex', 'cursor', 'devin', 'pi', 'gh', 'aws', 'node', 'python', 'docker'] as const;
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
  /** Its policy flag, `<component>-update-policy` (Claude Code's is claude-code-update-policy). */
  policyFlag: JsonFlagKey;
  /** Its policy for the owner and the box (a user alone where there is no box). */
  policy(user: FlagUser, box: FlagBox | null): Promise<ToolUpdatePolicy>;
  /**
   * Whether updating it is on for the owner and the box: off, the admin routes
   * answer 404 and a run gets restart none. The policy's mode is not off
   * (gate.ts). Pass the policy when
   * it has been read for the same user and box, so one decision reads the
   * flag once.
   */
  enabled(user: FlagUser, box: FlagBox | null, policy?: ToolUpdatePolicy): Promise<boolean>;
  /**
   * Whether the sweep updates it on its own for the owner and the box
   * (autoRuns.ts): the policy's mode is auto (gate.ts). The policy as for
   * `enabled`.
   */
  auto(user: FlagUser, box: FlagBox | null, policy?: ToolUpdatePolicy): Promise<boolean>;
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
   * pinned build, pi's newest pinned version. "Behind" then compares with it, not with the newest version
   * in the fleet (fleet.ts behindReference), and the preview names it as the
   * target.
   */
  latestReference?: string;
  /**
   * Updated only at the box's start (Docker: an upgrade restarts dockerd,
   * which stops every container). Its runs are never sent to a running box:
   * they wait `requested` (AT_START_EXPIRE_MS) until the box's boot unit asks
   * for them, before the tool's service starts (run.ts, runs.ts boxPolicy).
   */
  atStart?: true;
}

/** A tool's one flag read, for the owner and the box: its policy. */
interface ToolFlagReads {
  policy(user: FlagUser, box: FlagBox | null): Promise<ToolUpdatePolicy>;
}

/**
 * A tool's policy, and its on/off decisions read from it (gate.ts): the
 * policy flag for the owner and the box, and its mode decides. The read
 * stays literal per tool, for flags.test.ts and code references.
 */
function gated(policyFlag: JsonFlagKey, read: ToolFlagReads): Pick<ToolDescriptor, 'policyFlag' | 'policy' | 'enabled' | 'auto'> {
  return {
    policyFlag,
    policy: read.policy,
    enabled: async (user, box, known) => modeEnabled((known ?? await read.policy(user, box)).mode),
    auto: async (user, box, known) => modeAuto((known ?? await read.policy(user, box)).mode),
  };
}

export const TOOL_REGISTRY: Record<ToolComponent, ToolDescriptor> = {
  claude: {
    component: 'claude',
    displayName: 'Claude Code',
    inventoryName: 'claude',
    providers: ['claude'],
    ...gated(CLAUDE_UPDATE_POLICY_FLAG, {
      policy: async (user, box) => parseClaudeUpdatePolicy(await jsonVariation(CLAUDE_UPDATE_POLICY_FLAG, user, null, box)),
    }),
    runnerFloor: true,
    capability: 'tool-update-v1',
    isVersion: isClaudeVersion,
  },
  codex: {
    component: 'codex',
    displayName: 'Codex',
    inventoryName: 'codex',
    providers: ['codex'],
    ...gated(CODEX_UPDATE_POLICY_FLAG, {
      policy: async (user, box) => parseCodexUpdatePolicy(await jsonVariation(CODEX_UPDATE_POLICY_FLAG, user, null, box)),
    }),
    runnerFloor: false,
    capability: 'tool-update-codex-v1',
    isVersion: isClaudeVersion,
  },
  cursor: {
    component: 'cursor',
    displayName: 'Cursor agent',
    inventoryName: 'cursor-agent',
    providers: ['cursor'],
    ...gated(CURSOR_UPDATE_POLICY_FLAG, {
      policy: async (user, box) => parseCursorUpdatePolicy(await jsonVariation(CURSOR_UPDATE_POLICY_FLAG, user, null, box)),
    }),
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
    ...gated(DEVIN_UPDATE_POLICY_FLAG, {
      policy: async (user, box) => parseDevinUpdatePolicy(await jsonVariation(DEVIN_UPDATE_POLICY_FLAG, user, null, box)),
    }),
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
    ...gated(PI_UPDATE_POLICY_FLAG, {
      policy: async (user, box) => parsePiUpdatePolicy(await jsonVariation(PI_UPDATE_POLICY_FLAG, user, null, box)),
    }),
    runnerFloor: false,
    capability: 'tool-update-pi-v1',
    isVersion: isClaudeVersion,
    latestReference: PI_PINNED_LATEST,
  },
  gh: {
    component: 'gh',
    displayName: 'GitHub CLI',
    inventoryName: 'gh',
    // No sessions: a gh is a short command, and no provider runs one in a pane.
    providers: [],
    ...gated(GH_UPDATE_POLICY_FLAG, {
      policy: async (user, box) => parseGhUpdatePolicy(await jsonVariation(GH_UPDATE_POLICY_FLAG, user, null, box)),
    }),
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
    ...gated(AWS_UPDATE_POLICY_FLAG, {
      policy: async (user, box) => parseAwsUpdatePolicy(await jsonVariation(AWS_UPDATE_POLICY_FLAG, user, null, box)),
    }),
    runnerFloor: false,
    capability: 'tool-update-aws-v1',
    isVersion: isClaudeVersion,
  },
  node: {
    component: 'node',
    displayName: 'Node',
    inventoryName: 'node',
    // The providers whose agents run on Node from its npm global: a run with
    // restart idle or force stops their sessions on the old Node through
    // each tool's own updater (Claude Code's, Codex's, pi's: deploy/
    // termag-node-update), so its report lists their agent panes, each
    // relaunched as its own provider's.
    providers: ['claude', 'codex', 'pi'],
    ...gated(NODE_UPDATE_POLICY_FLAG, {
      policy: async (user, box) => parseNodeUpdatePolicy(await jsonVariation(NODE_UPDATE_POLICY_FLAG, user, null, box)),
    }),
    runnerFloor: false,
    capability: 'tool-update-node-v1',
    isVersion: isClaudeVersion,
  },
  python: {
    component: 'python',
    displayName: 'Python',
    inventoryName: 'python',
    // No sessions: no provider runs Python in an agent pane, and a process on
    // the old patch keeps it until it exits (deploy/termag-python-update keeps
    // that patch installed while one runs from it).
    providers: [],
    ...gated(PYTHON_UPDATE_POLICY_FLAG, {
      policy: async (user, box) => parsePythonUpdatePolicy(await jsonVariation(PYTHON_UPDATE_POLICY_FLAG, user, null, box)),
    }),
    runnerFloor: false,
    capability: 'tool-update-python-v1',
    isVersion: isClaudeVersion,
  },
  docker: {
    component: 'docker',
    displayName: 'Docker',
    inventoryName: 'docker',
    // No sessions: containers are the owner's, and none runs while it updates.
    providers: [],
    ...gated(DOCKER_UPDATE_POLICY_FLAG, {
      policy: async (user, box) => parseDockerUpdatePolicy(await jsonVariation(DOCKER_UPDATE_POLICY_FLAG, user, null, box)),
    }),
    runnerFloor: false,
    capability: 'tool-update-docker-v1',
    isVersion: isClaudeVersion,
    atStart: true,
  },
};

/** The descriptor for a component a caller named, or null for one termag does not update. */
export function toolDescriptor(component: unknown): ToolDescriptor | null {
  return isToolComponent(component) ? TOOL_REGISTRY[component] : null;
}

/** The answer for a component the registry does not list. */
export const UNKNOWN_COMPONENT = { code: 'unknown_component', error: `component must be one of ${TOOL_COMPONENTS.join(', ')}` } as const;
