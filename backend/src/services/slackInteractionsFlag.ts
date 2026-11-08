/**
 * The Slack app's off switch: the boolean flag
 * `slack-interactions-enabled`. Off, termag does nothing in Slack: every
 * event, slash command, button, shortcut and view is acknowledged and dropped
 * (the Bolt middleware below), and the app's Web API client refuses every
 * call but `auth.test` (gateSlackClient). That leaves the Slack app installed
 * and its OAuth client working, so the Slack MCP server's sign-in, which uses
 * the termag Slack app as its client and pins the workspace with the bot's
 * auth.test (services/mcpOAuthSlackTeam.ts), keeps working. MCP calls
 * themselves go to mcp.slack.com with each person's own user token, not
 * through the bot.
 *
 * It is read for the orchestrator's service context plus the Slack workspace
 * and org in play (serviceSlackFlagContext): an event's own (Bolt's context, else
 * the payload), and for the app's client, which posts as the bot, the bot's
 * workspace from auth.test, asked once per process. So a rule can turn Slack
 * on for one workspace (`slack-workspace`, key T…) or a whole Enterprise Grid
 * org (`slack-org`, key E…) and leave it off everywhere else. With no
 * workspace known (the bot's auth.test failed, or a payload names none),
 * Slack is off: an unknown workspace must not slip past a rule that turns
 * its workspace off.
 *
 * It falls back on, so a deployment without a flag source keeps its Slack bot.
 * But while a flag source exists and has not received its flags yet
 * (a slow start, or the flag source down at boot), Slack stays off: the switch is
 * there to keep the bot quiet in a workspace, and a fallback must not undo it.
 */
import { boolVariationForContext, flagsInitialized } from './featureFlags';
import { serviceSlackFlagContext, type FlagSlackWorkspace } from './featureFlags';
import { deploymentEnvironment } from './otel';
import { termagVersion } from './termagVersion';

export const SLACK_INTERACTIONS_FLAG = 'slack-interactions-enabled';

/** The Web API methods the client still calls when the switch is off. */
export const SLACK_METHODS_WHEN_OFF: ReadonlySet<string> = new Set(['auth.test']);

/** The Slack error code a refused call carries, as Slack's own refusals do (`data.error`). */
export const SLACK_OFF_ERROR = 'termag_slack_interactions_off';

/** Shown to someone who runs a slash command while the switch is off. */
export const SLACK_OFF_COMMAND_TEXT = "termag isn't available in Slack yet.";

export type SlackWorkspaceLookup = () => Promise<FlagSlackWorkspace | null>;
export type SlackInteractionsCheck = (workspace: FlagSlackWorkspace) => Promise<boolean>;

/**
 * Whether termag may act in this workspace. With no workspace (the bot's
 * auth.test failed, or a payload names none) it is off without asking
 * the flag source: a rule that turns one workspace or org off must not be
 * skipped because the workspace is unknown, and the fallthrough decide.
 */
export async function slackInteractionsAllowed(workspace: FlagSlackWorkspace | null, enabled: SlackInteractionsCheck = slackInteractionsEnabled): Promise<boolean> {
  return workspace ? enabled(workspace) : false;
}

export async function slackInteractionsEnabled(workspace: FlagSlackWorkspace): Promise<boolean> {
  if (!flagsInitialized()) return false;
  const sha = await termagVersion().then(v => v.sha, () => null);
  return boolVariationForContext(SLACK_INTERACTIONS_FLAG, serviceSlackFlagContext(sha, deploymentEnvironment(), workspace), true);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/**
 * The workspace a Bolt request is from: Bolt's context (teamId, enterpriseId),
 * else the payload's team_id / team.id and enterprise_id / enterprise.id. Pure.
 */
export function workspaceOfRequest(context: unknown, body: unknown): FlagSlackWorkspace | null {
  const c = (context ?? {}) as Record<string, unknown>;
  const b = (body ?? {}) as Record<string, unknown>;
  const team = (b.team ?? {}) as Record<string, unknown>;
  const enterprise = (b.enterprise ?? {}) as Record<string, unknown>;
  const teamId = str(c.teamId) ?? str(b.team_id) ?? str(team.id);
  const enterpriseId = str(c.enterpriseId) ?? str(b.enterprise_id) ?? str(enterprise.id);
  if (!teamId && !enterpriseId) return null;
  return { teamId: teamId ?? '', enterpriseId };
}

/** How long after a failed auth.test the bot's workspace is asked again. */
export const BOT_WORKSPACE_RETRY_MS = 30_000;

/**
 * The bot's own workspace, from auth.test on this client (a call the gate
 * always lets through), asked once and kept. A failed ask is null, so every
 * call is refused (slackInteractionsAllowed), and is asked again on the first
 * call after BOT_WORKSPACE_RETRY_MS, so an outage does not send an auth.test
 * per refused call.
 */
export function botWorkspaceLookup(client: unknown, now: () => number = Date.now): SlackWorkspaceLookup {
  let known: Promise<FlagSlackWorkspace | null> | null = null;
  let failedAt: number | null = null;
  return () => {
    if (failedAt !== null && now() - failedAt < BOT_WORKSPACE_RETRY_MS) return Promise.resolve(null);
    known ??= (async () => {
      try {
        const r = await (client as { auth: { test: () => Promise<Record<string, unknown>> } }).auth.test();
        const teamId = str(r.team_id);
        if (!teamId) throw new Error('auth.test named no team');
        failedAt = null;
        return { teamId, enterpriseId: str(r.enterprise_id), name: str(r.team) };
      } catch (err) {
        console.warn(`[SLACK] auth.test failed, so the bot's workspace is unknown and its Web API calls are refused until it answers:`, (err as Error).message);
        known = null;
        failedAt = now();
        return null;
      }
    })();
    return known;
  };
}

/** The method a request is for: makeRequest gets the method name, or a full URL for a file upload. */
function methodOf(url: string): string {
  return /^https?:\/\//.test(url) ? url : url.replace(/^\/+/, '');
}

function offError(method: string): Error {
  // The shape @slack/web-api gives a platform error, so callers that read
  // `err.data.error` treat it as any other refusal.
  const err = new Error(`An API error occurred: ${SLACK_OFF_ERROR}`) as Error & { code: string; data: unknown };
  err.code = 'slack_webapi_platform_error';
  err.data = { ok: false, error: SLACK_OFF_ERROR, method };
  return err;
}

const GATED = Symbol('slackInteractionsGated');
let refusedLogged = false;

/**
 * Makes a WebClient refuse every call but SLACK_METHODS_WHEN_OFF while the
 * switch is off for `workspace`, decided per call. Wraps the instance's
 * makeRequest: each bound method (`client.chat.postMessage`, …) goes through
 * apiCall, which looks makeRequest up on the instance, and so does
 * filesUploadV2's upload. slackInteractionsFlag.test.ts calls a real WebClient
 * to keep that true across @slack/web-api upgrades. Idempotent; returns the client.
 */
export function gateSlackClient<T>(client: T, workspace: SlackWorkspaceLookup, enabled: SlackInteractionsCheck = slackInteractionsEnabled): T {
  const c = client as unknown as { makeRequest?: (url: string, ...rest: unknown[]) => Promise<unknown>; [GATED]?: true };
  if (!c || typeof c.makeRequest !== 'function' || c[GATED]) return client;
  const original = c.makeRequest.bind(c);
  c.makeRequest = async (url: string, ...rest: unknown[]) => {
    const method = methodOf(url);
    if (!SLACK_METHODS_WHEN_OFF.has(method) && !(await slackInteractionsAllowed(await workspace(), enabled))) {
      if (!refusedLogged) {
        refusedLogged = true;
        console.log(`[SLACK] ${SLACK_INTERACTIONS_FLAG} is off: Slack Web API calls are refused (first: ${method})`);
      }
      throw offError(method);
    }
    return original(url, ...rest);
  };
  c[GATED] = true;
  return client;
}

interface BoltMiddlewareArgs {
  body?: unknown;
  context?: unknown;
  command?: unknown;
  ack?: (response?: unknown) => Promise<void>;
  client?: unknown;
  next: () => Promise<void>;
}

/**
 * Bolt global middleware: off for the request's workspace (or with none in
 * the request), acknowledges
 * whatever came in (a slash command with a one-line ephemeral notice) and
 * stops there, so no listener runs. On, gates the listener's own client for
 * that workspace too, so a long run (an agent turn streaming into a thread)
 * stops posting if the switch goes off mid-way.
 */
export function slackInteractionsMiddleware(enabled: SlackInteractionsCheck = slackInteractionsEnabled) {
  return async (args: BoltMiddlewareArgs): Promise<void> => {
    const workspace = workspaceOfRequest(args.context, args.body);
    if (!(await slackInteractionsAllowed(workspace, enabled))) {
      if (args.ack) {
        try {
          await (args.command ? args.ack({ response_type: 'ephemeral', text: SLACK_OFF_COMMAND_TEXT }) : args.ack());
        } catch (err) {
          console.warn('[SLACK] ack while interactions are off failed:', (err as Error).message);
        }
      }
      return;
    }
    if (args.client) gateSlackClient(args.client, async () => workspace, enabled);
    await args.next();
  };
}

export function resetSlackInteractionsForTests(): void {
  refusedLogged = false;
}
