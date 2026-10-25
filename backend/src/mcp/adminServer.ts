/**
 * Admin MCP server — Streamable HTTP, mounted in-process at
 * `${BASE_PATH}/mcp/admin`.
 *
 * Auth is requireAdmin (session cookie or admin-scoped bearer); the transport
 * is stateless (no session id), one McpServer + transport per request, which
 * is the SDK's documented pattern and keeps the single-replica constraint
 * irrelevant. Every tool maps 1:1 onto a function in services/admin/* that the
 * REST routes also call, so the two surfaces cannot drift. Tools are read-only
 * and never expose pane content.
 *
 * Connect from Claude Code:
 *   claude mcp add --transport http termag-admin https://<host>/termag/mcp/admin \
 *     --header "Authorization: Bearer tmag_…"
 */
import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { recordAudit } from '../middleware/admin';
import { parseRange, type Range } from '../services/admin/range';
import { listInstances, fleetOverview, provisioningStats, getInstance } from '../services/admin/fleetQueries';
import { listUsers, getUser, activeUsers } from '../services/admin/userQueries';
import { userGrowth, GROWTH_BUCKETS, GROWTH_DEFAULT_LIMIT, GROWTH_MAX_LIMIT } from '../services/admin/userGrowth';
import { tokenReport, worktimeReport, TOKEN_GROUPS, WORKTIME_GROUPS } from '../services/admin/usageQueries';
import { listProjects, projectCounts, liveSessions, summarizeSessions } from '../services/admin/inventoryQueries';
import { computeSignals } from '../services/admin/signalsData';
import { systemHealth } from '../services/admin/systemQueries';
import { adminCloudSessions, capacity, cloudReport, cloudSummary, orchestratorHealth, pipelineHealth, REPORT_GROUPS } from '../services/admin/claudeRunnerQueries';
import { prisma } from '../db';
import { softwareMatrix, softwareHost, clientVersions } from '../services/software/queries';
import { prSummary, prContributors, prTrend, prGroups, prIngestStatus, prReviews, prReviewers, prReviewTrend } from '../services/prAnalytics/queries';
import { REVIEW_TREND_MAX_WEEKS } from '../services/prAnalytics/reviews';
import { VIEWS, BASES } from '../services/prAnalytics/stats';
import { getSpendConfig, spendReport, spendTrendReport, TREND_MAX_WEEKS } from '../services/admin/spend/queries';

const rangeArgs = {
  range: z.enum(['today', '7d', '30d']).optional().describe('Preset window (UTC day keys). Default 7d.'),
  from: z.string().optional().describe('YYYY-MM-DD start, inclusive. Overrides range.'),
  to: z.string().optional().describe('YYYY-MM-DD end, inclusive. Default today.'),
};

function rangeFrom(args: { range?: string; from?: string; to?: string }): Range {
  const r = parseRange(args);
  if ('error' in r) throw new Error(r.error);
  return r;
}

const RANGE_NOTE = 'Token/visit days are UTC; worktime days are server-local.';
const STALENESS = {
  live: 'live (in-memory status map + one tmux-list per connected host)',
  sampler: 'token rows refresh every ~5 min per connected host; offline hosts are stale',
  rollup: 'banked when a working/human session ends; in-flight time is not included',
};

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const json = (v: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] });

function buildServer(actor: { id: string; tokenId: string | null }): McpServer {
  const server = new McpServer(
    { name: 'termag-admin', version: '0.1.0' },
    { instructions: `Read-only administrative view of one termag orchestrator: boxes, users, projects, live sessions, token usage, working time, behaviour signals, GitHub PR analytics and reviews per repo group, estimated AI spend and system health. Aggregates and metadata only — never terminal contents. This token cannot mint tokens, grant admin or take any action; those need a signed-in admin in the web UI. ${RANGE_NOTE}` },
  );

  const tool = <A extends z.ZodRawShape>(name: string, description: string, shape: A, fn: (args: z.infer<z.ZodObject<A>>) => Promise<unknown>) => {
    server.registerTool(name, { description, inputSchema: shape, annotations: { readOnlyHint: true, openWorldHint: false } }, (async (args: z.infer<z.ZodObject<A>>) => {
      try {
        const out = await fn(args);
        recordAudit({ actorId: actor.id, tokenId: actor.tokenId, surface: 'mcp', action: name, args: args as Record<string, unknown>, outcome: 'ok' });
        return json(out);
      } catch (err) {
        recordAudit({ actorId: actor.id, tokenId: actor.tokenId, surface: 'mcp', action: name, args: args as Record<string, unknown>, outcome: 'error' });
        return { content: [{ type: 'text', text: `error: ${(err as Error).message}` }], isError: true } as ToolResult;
      }
    }) as never);
  };

  tool('fleet_overview', `Counts of boxes by status/kind/region, how many agents are connected, and how many ready boxes have no agent. ${STALENESS.live}.`, {}, () => fleetOverview());
  tool('list_instances', `Every box with owner, status, provisioning time, connected flag, project counts, last project activity and usage-scan health. ${STALENESS.live}.`,
    { includeTerminated: z.boolean().optional().describe('Include terminated boxes (default false).') },
    a => listInstances({ includeTerminated: a.includeTerminated }));
  tool('get_instance', 'One box in detail: the list_instances row plus its projects and agent tokens.', { id: z.string() }, async a => (await getInstance(a.id)) ?? { error: 'not found' });
  tool('provisioning_stats', 'Cold-provisioning durations (p50/p95/max seconds), failures by reason, and a per-week breakdown for EC2 boxes created in the range.', rangeArgs, a => provisioningStats(rangeFrom(a)));

  tool('list_users', `Directory: every user with role, last seen, boxes (total/ready/connected), projects, shares, and range rollups of agent time, human time, tokens and cache ratio. ${RANGE_NOTE}`, rangeArgs, a => listUsers(rangeFrom(a)));
  tool('get_user', 'One user in detail: the list_users row plus boxes, projects (projectList) and unexpired tokens (tokenList).', { id: z.string(), ...rangeArgs }, async a => (await getUser(a.id, rangeFrom(a))) ?? { error: 'not found' });
  tool('active_users', 'Daily active users under several definitions (signed in, agent worked, human worked, used tokens, switched projects) plus range-distinct totals.', rangeArgs, a => activeUsers(rangeFrom(a)));
  tool('user_growth', `Growth over time: new users per UTC day, week (Monday start) or month, by first sign-in (users.createdAt), with the running total, the all-time total, the first sign-in, and new users in the current and previous bucket. Default window: ${GROWTH_BUCKETS.map(b => `${GROWTH_DEFAULT_LIMIT[b]} ${b}s`).join(', ')}.`,
    {
      bucket: z.enum(GROWTH_BUCKETS).optional().describe('Bucket size. Default week.'),
      limit: z.number().int().min(1).max(GROWTH_MAX_LIMIT).optional().describe('How many buckets, ending with the current one.'),
    },
    a => userGrowth(a.bucket ?? 'week', a.limit));

  tool('list_projects', 'Projects with owner, box, provider, workstream and share counts, last activity. Filter by user, box, provider, archived, stale days.',
    {
      userId: z.string().optional(), instanceId: z.string().optional().describe("Box id, or 'legacy' for projects on the orchestrator host."),
      provider: z.string().optional().describe('Any workstream of the project runs this provider.'),
      kind: z.string().optional().describe("Project kind: 'normal', 'metaterm' or 'automation'. Default: all."),
      archived: z.boolean().optional().describe('Default false: active projects.'),
      staleDays: z.number().int().positive().optional().describe('Only projects with no agent activity for this many days.'),
    },
    a => listProjects(a));
  tool('project_counts', 'Totals: projects active/archived, by kind and provider, workstreams, shares, invites by status.', {}, () => projectCounts());
  tool('live_sessions', `Every session pane org-wide with status (working/waiting/idle/not_running), waiting reason, rate-limit flag, context tokens, provider, host, plus a summary. ${STALENESS.live}. No pane content.`,
    { status: z.enum(['working', 'waiting', 'idle', 'not_running']).optional().describe('Filter agent panes by status.'), agentOnly: z.boolean().optional().describe('Default true: only agent panes.') },
    async a => {
      const rows = await liveSessions();
      const filtered = rows.filter(r => (a.agentOnly ?? true ? r.role === 'agent' : true) && (!a.status || r.status === a.status));
      return { summary: summarizeSessions(rows), rows: filtered };
    });

  tool('token_usage', `Token totals (input/output/cache read/cache create/calls), cache ratio and estimated share, grouped by any of ${TOKEN_GROUPS.join(', ')}. ${STALENESS.sampler}. Labels resolve user/host/project ids.`,
    { ...rangeArgs, groupBy: z.array(z.enum(TOKEN_GROUPS)).optional().describe('Default ["day"].') },
    a => tokenReport(rangeFrom(a), a.groupBy?.length ? a.groupBy : ['day']));
  tool('worktime', `Agent and human working milliseconds grouped by any of ${WORKTIME_GROUPS.join(', ')}; also lists worktime usernames that match no user. ${STALENESS.rollup}. Days are server-local.`,
    { ...rangeArgs, groupBy: z.array(z.enum(WORKTIME_GROUPS)).optional().describe('Default ["day"].') },
    a => worktimeReport(rangeFrom(a), a.groupBy?.length ? a.groupBy : ['day']));

  tool('signals', 'Ranked org-wide attention list: idle/offline/stuck/failed boxes, long waits, rate limits, context danger, token burn vs each user\'s median, cache-ratio outliers, stale projects, unattributed worktime. Includes the thresholds used.', {}, () => computeSignals());
  // Claude Code cloud sessions: the same
  // functions the /api/admin/claude-runner routes call. No titles: the title is an owner's first prompt.
  tool('cloud_sessions', `Claude Code cloud sessions org-wide: runs open now grouped by box (owner, slot, state, client platform, tmux liveness, live working/waiting/idle status), sessions the spawn hook refused with the reason and how long they have waited, and recent ends with duration and exit reason. ${STALENESS.live}. No titles.`,
    { days: z.number().int().min(1).max(30).optional().describe('Days of history for recent ends (default 7).') },
    a => adminCloudSessions(a.days ?? 7));
  tool('cloud_summary', 'Cheap counts of Claude Code cloud sessions: running, starting and queued now, and open runs per box id and per user id. Postgres only, no box RPC.', {}, () => cloudSummary());
  tool('cloud_report', `Claude Code cloud session history over a range: sessions, runs, slot-seconds held, ends by exit reason, lost runs, refusals by category (github, agent-too-old, no-box, boxes-full, hook-gave-up, agent-failed), queue-wait and spawn-latency p50/p95, grouped by one of ${REPORT_GROUPS.join(', ')}, with totals and the prior range. Events live 30 days, so refusals and latencies cover at most that. ${RANGE_NOTE}`,
    { ...rangeArgs, groupBy: z.enum(REPORT_GROUPS).optional().describe('Default day.') },
    a => cloudReport(rangeFrom(a), a.groupBy ?? 'day'));
  tool('cloud_pipeline', 'Per box over the last 30 days: how many cloud runs posted started, got an end report, carry a platform and a title (counts only), ended lost or are open, with the box\'s agent commit. A box whose runs never post started runs a wrapper from before the hooks.', {}, () => pipelineHealth());
  tool('cloud_capacity', 'Cloud session capacity: every box judged by the spawn route\'s eligibility rule (ec2, ready, agent connected and able to run a runner), slots used by open runs and free against the per-box cap, rolled up per owner with a one-line description of their boxes. Postgres and the agent registry only.', {}, () => capacity());
  tool('orchestrator_health', 'The Claude Code runner orchestrator\'s own /healthz on this host: whether its last poll of Anthropic succeeded (`connected`), the spawn queue by state (`queue_counts`), the last poll time; cached ten seconds. `available: false` with a reason on a host without the orchestrator or with its unit down.', {}, () => orchestratorHealth());
  const prArgs = {
    group: z.string().describe('Repo group slug (pr_groups lists them).'),
    view: z.enum(VIEWS).optional().describe('credited (default): human PRs plus agent PRs credited to the person they were done for; humans: human-authored only; all: every author, bots included.'),
    basis: z.enum(BASES).optional().describe('merged (default) or opened.'),
  };
  const notFound = <T>(v: T | null) => v ?? { error: 'no such group' };
  tool('pr_groups', 'PR analytics repo groups: members (repo, pattern, topic), exclusions, and the repos each resolved to with their PR counts.', {}, () => prGroups());
  tool('pr_summary', 'For one repo group and the last 1, 7 and 30 days: PRs (opened, merged, on the chosen basis), PRs by author class (human, agent, automation: the with/without-bots split), agent-assisted PRs, distinct contributors, and PRs per contributor p50/p95/mean/max.',
    prArgs, async a => notFound(await prSummary(a.group, a.view ?? 'credited', a.basis ?? 'merged')));
  tool('pr_contributors', 'Top PR contributors in a repo group over 1, 7 or 30 days: login, PRs, share, agent PRs credited to them, agent-assisted PRs, median PR size (additions + deletions), and the termag user when their GitHub is connected.',
    { ...prArgs, window: z.union([z.literal(1), z.literal(7), z.literal(30)]).optional().describe('Days. Default 30.'), limit: z.number().int().min(1).max(100).optional().describe('Default 10.') },
    async a => notFound(await prContributors(a.group, a.view ?? 'credited', a.basis ?? 'merged', a.window ?? 30, a.limit ?? 10)));
  tool('pr_trend', 'Weekly (Monday UTC) PRs in a repo group by author class, PRs in the chosen view and distinct contributors.',
    { ...prArgs, weeks: z.number().int().min(1).max(78).optional().describe('Default 26.') },
    async a => notFound(await prTrend(a.group, a.view ?? 'credited', a.basis ?? 'merged', a.weeks ?? 26)));
  const groupArg = { group: prArgs.group };
  tool('pr_reviews', 'For one repo group and the last 1, 7 and 30 days: reviews (one person on one PR, however many rounds), reviewers, reviews per reviewer p50/p95/mean/max, approvals, changes requested and comment-only reviews, inline comments by people, comments by people per merged PR (p50/p95/max) with the share bots wrote, and merged PRs split by approval: the Cursor approval agent alone, a human (with or without the agent), or unapproved, counting only repos where the agent has approved. Reviewers are people, never the PR author.',
    groupArg, async a => notFound(await prReviews(a.group)));
  tool('pr_reviewers', 'Top reviewers in a repo group over 1, 7 or 30 days: reviews, approvals, changes requested, comment-only, inline comments, deciding approvals (theirs was the last human approval before a merge in the window), median hours from ready to their first review, distinct authors helped, and the termag user when their GitHub is connected.',
    { ...groupArg, window: z.union([z.literal(1), z.literal(7), z.literal(30)]).optional().describe('Days. Default 30.'), limit: z.number().int().min(1).max(100).optional().describe('Default 10.') },
    async a => notFound(await prReviewers(a.group, a.window ?? 30, a.limit ?? 10)));
  tool('pr_review_trend', `Weekly (Monday UTC) reviews and reviewers in a repo group, and merged PRs approved by the approval agent alone, by a human, or unapproved. Reviews are kept ${REVIEW_TREND_MAX_WEEKS} weeks back.`,
    { ...groupArg, weeks: z.number().int().min(1).max(REVIEW_TREND_MAX_WEEKS).optional().describe(`Default ${REVIEW_TREND_MAX_WEEKS}.`) },
    async a => notFound(await prReviewTrend(a.group, a.weeks ?? REVIEW_TREND_MAX_WEEKS)));
  tool('pr_ingest_status', 'PR ingestion health: whose GitHub token ingests, the ingester state and rate-limit headroom, repos backfilled out of total, PRs stored, and per-repo errors.', {}, () => prIngestStatus());
  tool('software_summary', 'Deployed software: per component (termag commit, image, Claude hooks, Claude Code, Codex, Cursor, Devin, pi, Node, npm, gh, AWS CLI, tmux, git, Docker, Python, nginx, Envoy, otelcol, Postgres, OS, kernel) its reference version, how many hosts are current / behind / outdated / ahead / missing / unknown, and the spread of versions. Tools compare against the newest version in the fleet; termag and images against the newest box or orchestrator image.', {},
    async () => { const m = await softwareMatrix(); return { summary: m.summary, targets: m.targets, collector: m.collector }; });
  tool('software_matrix', 'Every host (the orchestrator, each box, each per-user agent on the orchestrator) with each component\'s version and state. Filter by component, owner, or only cells that need updating.',
    { component: z.string().optional(), owner: z.string().optional(), needsUpdate: z.boolean().optional().describe('Only hosts with a behind or outdated cell.') },
    async a => {
      const m = await softwareMatrix();
      const bad = new Set(['behind', 'outdated']);
      return m.hosts
        .filter(h => !a.owner || h.owner === a.owner)
        .map(h => ({ ...h, cells: a.component ? { [a.component]: h.cells[a.component] } : h.cells }))
        .filter(h => !a.needsUpdate || Object.values(h.cells).some(c => c && bad.has(c.state)));
    });
  tool('software_host', 'One host\'s components with versions, paths and states, and its last 100 version changes.', { hostKey: z.string().describe("'orchestrator', an instance id, or 'agent:<userId>'.") },
    async a => (await softwareHost(a.hostKey)) ?? { error: 'no such host' });
  tool('client_versions', 'The latest client version each user was seen with, per kind (web, mobile, cli, tui, metaterm), and whether it is current: web and mobile against the running orchestrator commit, the others against the newest seen.', {}, () => clientVersions());
  // Spend: estimates, tokens × dated prices plus cost pools (contracts, internal inference boxes).
  const spendArgs = { ...rangeArgs, active: z.boolean().optional().describe('Count only users active in the window (default false: all termag users).') };
  tool('spend_summary', `Estimated AI spend over a range: metered (tokens × dated prices; Claude priced at the assumed model mix while token rows carry no model) plus cost pools (vendor contracts at termag's share, internal inference boxes), totals, per head, annualised share of the fully loaded person cost, the per-person distribution, per-provider cost and $/M tokens, and each pool. Estimates for relative comparison, not accounting. ${RANGE_NOTE}`,
    spendArgs, async a => { const { people: _people, ...rest } = await spendReport(rangeFrom(a), a.active ?? false); return rest; });
  tool('spend_people', 'Estimated AI spend per person over a range: tokens, metered cost, each pool\'s share, total, annualised share of the loaded cost and top provider, most expensive first.',
    { ...spendArgs, limit: z.number().int().min(1).max(500).optional().describe('Default 50.') },
    async a => { const r = await spendReport(rangeFrom(a), a.active ?? false); return { window: r.window, denominator: r.denominator, people: r.people.slice(0, a.limit ?? 50) }; });
  tool('spend_trend', 'Estimated AI spend per Monday-UTC week: metered cost by provider and each cost pool\'s termag share.',
    { weeks: z.number().int().min(1).max(TREND_MAX_WEEKS).optional().describe('Default 12.') },
    a => spendTrendReport(a.weeks ?? 12));
  tool('spend_config', 'The spend model\'s assumptions: loaded cost per person, org headcount, the assumed model mix, the dated price table and the cost pools.', {}, () => getSpendConfig());
  tool('system_health','Orchestrator process (version, uptime, memory, auth mode), connected agents, in-memory status map, usage-scan health, database size and per-table rows/bytes.', {}, () => systemHealth());
  tool('audit_log', 'Recent admin REST requests and MCP tool calls: who, what, args summary, outcome.',
    { ...rangeArgs, limit: z.number().int().min(1).max(1000).optional(), actorId: z.string().optional() },
    async a => {
      const r = rangeFrom(a);
      const rows = await prisma.adminAuditLog.findMany({
        where: { at: { gte: r.sinceTs, lt: r.untilTs }, ...(a.actorId ? { actorId: a.actorId } : {}) },
        orderBy: { at: 'desc' }, take: a.limit ?? 200,
      });
      return rows;
    });

  return server;
}

/** Express handler for `${BASE_PATH}/mcp/admin` (GET/POST/DELETE). Run after requireAdmin. */
export async function handleAdminMcp(req: Request, res: Response): Promise<void> {
  const server = buildServer({ id: req.user!.id, tokenId: req.adminTokenId ?? null });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { void transport.close(); void server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[MCP-ADMIN] request failed:', (err as Error).message);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  }
}
