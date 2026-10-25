import 'dotenv/config';
// Must run before any module constructs a PrismaClient: derives DATABASE_URL
// from platform-injected PG_* variables when it is not set explicitly.
import './config/bootstrap';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import passport from 'passport';
import { join } from 'path';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { parse as parseCookie } from 'querystring';

import { configurePassport, authRouter, albSessionBridge, authMode, upgradeUserId } from './routes/auth';
import { stashPostLoginReturn } from './auth/postLoginReturn';
import { projectsRouter } from './routes/projects';
import { chatRouter } from './routes/chat';
import { CHAT_MESSAGE_BODY_LIMIT } from './services/chatImages';
import { chatsRouter } from './routes/chats';
import { claudeLoginRouter } from './routes/claudeLogin';
import { mayReceiveChat, setChatPushCallback, startChatRelay, startChatStatusSweep, stopChatStatusSweep } from './services/chatRunner';
import { statusRouter } from './routes/status';
import { browserRouter } from './routes/browser';
import { agentTokensRouter } from './routes/agentTokens';
import { usageRouter } from './routes/usage';
import { worktimeRouter } from './routes/worktime';
import { sharingRouter } from './routes/sharing';
import { sessionsRouter } from './routes/sessions';
import { metatermRouter } from './routes/metaterm';
import { visitsRouter } from './routes/visits';
import { warpRouter } from './routes/warp';
import { contextRouter } from './routes/context';
import { reviewRouter } from './routes/review';
import { instancesRouter } from './routes/instances';
import { sshKeysRouter } from './routes/sshKeys';
import { warmPoolRouter } from './routes/warmPool';
import { apiErrorHandler } from './middleware/errors';
import { isAllowedUpgradeOrigin } from './auth/wsOrigin';
import { workstreamsRouter } from './routes/workstreams';
import { featureFlagsRouter } from './routes/featureFlags';
import { credentialsRouter } from './routes/credentials';
import { mcpClientMetadataHandler, mcpConnectorsRouter } from './routes/mcpConnectors';
import { githubReposRouter } from './routes/githubRepos';
import { githubAuthzRouter } from './routes/githubAuthz';
import { claudeAuthzRouter } from './routes/claudeAuthz';
import { fireworksAuthzRouter } from './routes/fireworksAuthz';
import { mcpAuthzRouter } from './routes/mcpAuthz';
import { claudeRunnerRouter } from './routes/claudeRunner';
import { claudeRunnerEventsRouter } from './routes/claudeRunnerEvents';
import { boxUpdatePolicyRouter } from './routes/boxUpdatePolicy';
import { usersRouter } from './routes/users';
import { isOwnRunnerSessionStatus } from './services/claudeRunnerSpawn';
import { claudeSessionsRouter } from './routes/claudeSessions';
import { setCloudSessionChangeCallback } from './services/claudeSessionEvents';
import { coalesceWorkspaceChanges, setWorkspaceChangeCallback } from './services/workspaceEvents';
import { installWorkspaceWriteNotifier } from './services/workspaceWrites';
import { startCloudSessionSweeps, stopCloudSessionSweeps } from './services/claudeSessions';
import { getCallerProofConfig } from './services/callerIdentity';
import { providersRouter } from './routes/providers';
import { prsRouter } from './routes/prs';
import { pushRouter } from './routes/push';
import { termagVersion } from './services/termagVersion';
import { adminRouter } from './routes/admin';
import { requireAdmin } from './middleware/admin';
import { rateLimit } from './middleware/rateLimit';
import { handleAdminMcp } from './mcp/adminServer';
import { initFeatureFlags, closeFeatureFlags } from './services/featureFlags';
import { backfillBoxEcrPullPolicies, startProvisioningSweep, stopProvisioningSweep } from './services/boxProvisioner';
import { moveChatModelsToWorkflows } from './services/chatModelMove';
import { instanceStatus, startPowerSweep, stopPowerSweep } from './services/boxPower';
import { TERMINAL_BOX_PARKED_CLOSE_CODE, terminalAttachRefusal } from './services/boxPowerPolicy';
import { terminalSessionAccess } from './services/sessionAccess';
import { loadSharedScope, sendThroughShare, setShareChangeCallback, shareChangeFrames, shareChangeTouches, startSharedRefresh, statusRoute, type ScopeHolder } from './services/statusAudience';
import type { AgentStatus } from './types';
import { startWarmPoolReconciler, stopWarmPoolReconciler } from './services/warmPool';
import { startBoxUpdateSweep, stopBoxUpdateSweep } from './services/boxUpdate';
import { prismaCliAsk, startAskQueue, startAskReplies, startAskSweep, stopAskQueue, stopAskReplies, stopAskSweep } from './services/askService';
import { BRIEFING_RESULT_BODY_LIMIT, briefingsRouter } from './routes/briefings';
import { automationsRouter } from './routes/automations';
import { recheckMirrorsForMember } from './services/automations/memorySync';
import { startAutomationScheduler, stopAutomationScheduler } from './services/automations/scheduler';
import { startAutomationCompletion } from './services/automations/complete';
import { startBriefingScheduler, stopBriefingScheduler } from './services/briefing/scheduler';
import { registerBriefingSlackActions } from './services/briefing/slack';
import { startLifecycleSweep, stopLifecycleSweep } from './services/boxLifecycle';
import { startHostSampling, stopHostSampling } from './services/hostSamples';
import { startSoftwareCollector, stopSoftwareCollector } from './services/software/collector';
import { clientVersionMiddleware } from './services/software/clients';
import { requireAuth } from './middleware/auth';
import { spaStatic } from './middleware/spaStatic';
import { handleBrowserPaneSocket } from './routes/browserWs';
import { startPrIngester, stopPrIngester } from './services/prAnalytics/ingester';
import { startSegmentTracker, stopSegmentTracker } from './services/segments/tracker';
import { syncAdminBootstrap } from './services/admin/adminAccess';
import { setStatusChangeCallback, getStatus, getAllStatuses, hydrateStatuses, rehydrateStatuses, setStatusTimersSuspended } from './services/status';
import { createStatusTakeover } from './services/statusTakeover';
import { milestoneForSharedViewer } from './services/milestone';
import { startReviewSweep, stopReviewSweep, reviewForSharedViewer } from './services/reviewSweep';
import { startSpawnNudgeSweep, stopSpawnNudgeSweep } from './services/agentSpawnSweep';
import { spawnsRouter } from './routes/spawns';
import { handoffsRouter } from './routes/handoffs';
import { startHandoffSweep, stopHandoffSweep } from './services/agentHandoffSweep';
import { collabRouter } from './routes/collab';
import { registerCollabSlackActions } from './slack/collab';
import { startCollabNudgeSweep, stopCollabNudgeSweep } from './services/collabSweep';
import { initOtel, shutdownOtel } from './services/otel';
import { registerSpawnGauges } from './services/spawnMetrics';
import { debugLog } from './services/debugLog';
import { parseStatusKey } from './services/statusKey';
import { createSlackApp, startSlackApp, stopSlackApp } from './slack/app';
import { createDiscordClient, startDiscordClient, stopDiscordClient } from './discord/app';
import { validateAgentToken } from './routes/agentTokens';
import {
  registerAgent, isAgentConnected, isInstanceAgentConnected,
  requestTerminalStream, requestInstanceTerminalStream,
  sendTerminalInput, sendTerminalPasteImage, sendTerminalResize, sendTerminalMouse, closeTerminalStream,
  setAgentRegistryDraining,
} from './services/agentRegistry';
import { leaseConfigFromEnv, newHolder, OrchestratorLease } from './services/orchestratorLease';
import { prismaLeaseStore } from './services/orchestratorLeasePrisma';
import { createDrain, DRAIN_CLOSE_CODE, DRAIN_CLOSE_REASON } from './services/orchestratorDrain';
import { leaderOnly, type LeaderOnly } from './services/leaderOnly';
import { runnerUnitControlFromEnv } from './services/claudeRunnerUnit';
import type { Client as DiscordClient } from 'discord.js';
import { prisma as prismaIndex, getPool } from './db';
import { startTmuxPoller, stopTmuxPoller } from './services/tmuxPoller';
import { holdFramesUntilReady } from './services/socketHandoff';
import { cliApiRouter, cliBearer, cliDevicesRouter, type CliAuth } from './routes/cliApi';
import { cliAuthorizeRouter } from './routes/cliAuthorize';
import { AuthCodeStore } from './services/cliAuth';
import { cliJwtFromEnv } from './services/cliJwtKms';
import { prismaCliStore } from './services/cliStorePrisma';
import { prismaCliLifecycle } from './routes/cliLifecyclePrisma';
import { prismaCliTui } from './routes/cliTuiPrisma';
import { authenticateCliUpgrade, cliWsRoute, refusalResponse, watchCliSocket } from './routes/cliWs';
import { verifyAlbIdentity } from './auth/albOidc';
import { startHumanActivityTracker, stopHumanActivityTracker } from './services/humanActivity';
import { startProjectClone } from './services/projectClone';
import { startChatGate } from './services/chatGate';
import { cliCredentialsRouter } from './routes/cliCredentials';
import { prismaCliCredentials } from './services/cliCredentialsPrisma';
import { startWarpSampler, stopWarpSampler } from './services/warpSampler';
import { startContextSampler, stopContextSampler } from './services/contextSampler';
import { startTokenUsageSampler, stopTokenUsageSampler } from './services/tokenUsageSampler';
import { agentTokenForms, agentWsToken, QUERY_TOKEN_REFUSAL } from './auth/agentWsToken';
import { spaceCallerFromCli, spacesRouter } from './routes/spaces';
import { spaceFilesRouter } from './routes/spaceFiles';
import { previewLinkRouter, previewSharesRouter, defaultPreviewShareRouteDeps, installAutoPreviewShares } from './routes/previewShares';
import { installPreviewShareLinkHooks, startPreviewShareSweep, stopPreviewShareSweep } from './services/previewShareLinks';
import { FILE_LINK_PREFIX, spaceFileLinkPath } from './services/spaces/spaceLinks';
import { spaceObjects, spacesEnabledFor, spacesHtmlLinksEnabledFor, spacesSharingEnabledFor, spacesSweeper, spaceStore } from './services/spaces/spacesRuntime';

import { ltsRouter } from './slack/lts';
import { publishHomeView } from './slack/homeView';
import { getActiveHomeViewers } from './slack/events';

const app = express();
const server = createServer(app);
const PgSession = connectPgSimple(session);

const BASE_PATH = process.env.BASE_PATH ?? '';
const PORT = parseInt(process.env.PORT ?? '3040', 10);
// Unset listens on all interfaces. AUTH_MODE=local requires a loopback value.
const BIND_HOST = process.env.BIND_HOST?.trim() || undefined;
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173';

// --- Middleware ---
app.set('trust proxy', 1);
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
// Before express.json(): the GitHub broker's check reads GraphQL bodies raw.
// Registered only with a caller allowlist, so without one the path 404s.
const callerProof = getCallerProofConfig();
if (callerProof) {
  app.use(`${BASE_PATH}/internal/github-authz`, githubAuthzRouter(callerProof));
  app.use(`${BASE_PATH}/internal/claude-authz`, claudeAuthzRouter(callerProof));
  app.use(`${BASE_PATH}/internal/fireworks-authz`, fireworksAuthzRouter(callerProof));
  app.use(`${BASE_PATH}/internal/mcp-authz`, mcpAuthzRouter(callerProof));
}
// A briefing's result (the composed JSON plus the run's usage) may pass the
// global 100kb default; parsed here first, express.json() below skips it.
app.use(`${BASE_PATH}/api/briefings/:id/result`, express.json({ limit: BRIEFING_RESULT_BODY_LIMIT }));
// A chat message may carry images as base64 (services/chatImages.ts).
app.use(`${BASE_PATH}/api/projects/:id/chat/messages`, express.json({ limit: CHAT_MESSAGE_BODY_LIMIT }));
// Returning a session to the chat can carry the same image message.
app.use(`${BASE_PATH}/api/projects/:id/chat/reclaim`, express.json({ limit: CHAT_MESSAGE_BODY_LIMIT }));
app.use(express.json());
// Claude Code cloud sessions: the self-hosted orchestrator's spawn hook on this
// host asks for a one-shot runner on the session owner's box
//. Loopback + bearer; absent the token, the path 404s.
const claudeRunnerSpawnToken = process.env.CLAUDE_RUNNER_SPAWN_TOKEN?.trim();
if (claudeRunnerSpawnToken) {
  app.use(`${BASE_PATH}/internal/claude-runner`, claudeRunnerRouter(claudeRunnerSpawnToken, () => drain.isServing()));
}

// --- LTS API (mounted before session/passport — uses its own bearer auth) ---
let slackClient: import('@slack/web-api').WebClient | null = null;
let slackApp: ReturnType<typeof createSlackApp> | null = null;

if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
  slackApp = createSlackApp();
  slackClient = slackApp.client;
  registerBriefingSlackActions(slackApp);
  registerCollabSlackActions(slackApp);

  if (process.env.CAPTURE_API_SECRET) {
    const refreshAllHomeViews = async () => {
      const viewers = getActiveHomeViewers();
      await Promise.all([...viewers].map(uid => publishHomeView(slackApp!.client, uid).catch(() => {})));
    };

    app.use('/lts', ltsRouter(
      slackApp.client,
      (userId: string) => publishHomeView(slackApp!.client, userId),
      refreshAllHomeViews,
    ));
  }
}

const cliJwt = cliJwtFromEnv(process.env, `${FRONTEND_URL}${BASE_PATH}`);
cliJwt.catch(err => console.error('[CLI] access-token keys did not load; /api/cli/v1 answers 500:', err));
// The CLI sockets judge their bearer exactly as /api/cli/v1 does (routes/cliWs.ts).
const cliWsDeps = { store: prismaCliStore, jwt: cliJwt };

// Which client build each user runs. Ahead of the
// /api/cli/v1 routers, which finish every CLI and TUI request: it only reads
// headers here and looks up the user (req.user or res.locals.cliAuth) when the
// response finishes, so it needs nothing mounted before it.
app.use(`${BASE_PATH}/api`, clientVersionMiddleware);

// termag doctor's SSH-key and GitHub routes: part of the same bearer-only CLI
// API, so mounted ahead of the cookie stack too (routes/cliCredentials.ts).
app.use(`${BASE_PATH}/api/cli/v1`, cliCredentialsRouter({ store: prismaCliStore, jwt: cliJwt, credentials: prismaCliCredentials }));

// `termag space …`: the spaces API under the same bearer check, a device
// login acting as its user and a box token as its box (routes/spaces.ts).
app.use(`${BASE_PATH}/api/cli/v1/spaces`, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); },
  cliBearer({ store: prismaCliStore, jwt: cliJwt }),
  spacesRouter({
    store: spaceStore, objects: spaceObjects, enabled: spacesEnabledFor, sharing: spacesSharingEnabledFor, onMemberChanged: recheckMirrorsForMember,
    caller: (_req, res) => {
      const auth = res.locals.cliAuth as CliAuth | undefined;
      return auth ? spaceCallerFromCli(auth) : null;
    },
    fileLink: (space, path) => `${FRONTEND_URL}${spaceFileLinkPath(BASE_PATH, space, path)}`,
  }));

// --- termag CLI API (bearer-only, before session/passport/ALB bridge) ---
// Mounted ahead of the cookie stack on purpose: see routes/cliApi.ts.
const cliAuthCodes = new AuthCodeStore();
app.use(`${BASE_PATH}/api/cli/v1`, cliApiRouter({ store: prismaCliStore, codes: cliAuthCodes, jwt: cliJwt, tui: prismaCliTui, lifecycle: prismaCliLifecycle, ask: prismaCliAsk }));

const sessionMiddleware = session({
  // connect-pg-simple's `session` table is declared in prisma/schema.prisma
  // (model Session) purely so `prisma db push` creates and keeps it during the
  // migration step — on some platforms that step runs as the `migration` DB user,
  // while the server's `application` user may not be allowed to CREATE TABLE.
  // createTableIfMissing stays as a fallback for deployments that never run
  // `db push`; the app itself never reads the table through Prisma.
  //
  // With RDS IAM auth there is no DATABASE_URL to hand over; share the IAM-token
  // pool Prisma runs on instead (db.ts) so sessions get the same credentials.
  store: new PgSession(
    getPool()
      ? { pool: getPool()!, createTableIfMissing: true }
      : { conString: process.env.DATABASE_URL, createTableIfMissing: true },
  ),
  name: 'termag.sid',
  secret: process.env.SESSION_SECRET ?? 'dev-secret',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    path: '/termag',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 90 * 24 * 60 * 60 * 1000, // 90 days
  },
});

// Scope session + passport to BASE_PATH. Without this, a request outside
// /termag (favicon.ico, dev-tools probes, anything Apache forwards) skips
// the session middleware (cookie path mismatch — see express-session
// index.js: "pathname mismatch") but still hits passport.session(), which
// throws "Login sessions require session support" because req.session is
// undefined.
app.use(BASE_PATH || '/', sessionMiddleware);
app.use(BASE_PATH || '/', passport.initialize());
app.use(BASE_PATH || '/', passport.session());
// Turn the ALB's verified Okta identity (x-amzn-oidc-data) into a session.
app.use(BASE_PATH || '/', albSessionBridge);
// The web bundle's beacon (on load, then hourly): the middleware above records its build.
app.post(`${BASE_PATH}/api/client/hello`, requireAuth, (_req, res) => { res.status(204).end(); });

configurePassport();

// --- Routes ---
app.use(`${BASE_PATH}/auth/cli`, cliAuthorizeRouter({
  codes: cliAuthCodes,
  basePath: BASE_PATH,
  frontendUrl: FRONTEND_URL,
  edgeIdentityEmail: authMode() === 'okta'
    ? async (req) => (await verifyAlbIdentity(req))?.email ?? null
    : undefined,
  rememberReturnTo: authMode() === 'okta'
    ? undefined
    : (req, url) => new Promise((resolve, reject) => {
      if (!stashPostLoginReturn(req.session, BASE_PATH, url)) { resolve(false); return; }
      req.session.save((err) => (err ? reject(err) : resolve(true)));
    }),
}));
app.use(`${BASE_PATH}/auth`, authRouter());
app.use(`${BASE_PATH}/api/projects`, projectsRouter());
app.use(`${BASE_PATH}/api/projects`, chatRouter());
app.use(`${BASE_PATH}/api/chats`, chatsRouter());
app.use(`${BASE_PATH}/api/projects`, claudeLoginRouter());
app.use(`${BASE_PATH}/api/status`, statusRouter());
// A box reports the end of a Claude Code cloud session the spawn route started
// there.
app.use(`${BASE_PATH}/api/claude-runner`, claudeRunnerEventsRouter());
// A box asks whether it may update itself before a run of its update service
// (deploy/termag-box-update --when-enabled): the box-auto-update-enabled flag
// for its owner. Anything but a yes from here, this route included when it is
// missing, leaves the box as it is.
app.use(`${BASE_PATH}/api/box-update`, boxUpdatePolicyRouter());
// The person picker in the share and space dialogs (routes/users.ts).
app.use(`${BASE_PATH}/api/users`, usersRouter());
// The owner's view of those sessions: runs, events, runner log, end.
app.use(`${BASE_PATH}/api/claude-sessions`, claudeSessionsRouter());
app.use(`${BASE_PATH}/api/browser`, browserRouter());
app.use(`${BASE_PATH}/api/agent-tokens`, agentTokensRouter());
app.use(`${BASE_PATH}/api/cli-devices`, cliDevicesRouter({ store: prismaCliStore }));
app.use(`${BASE_PATH}/api/usage`, usageRouter());
app.use(`${BASE_PATH}/api/worktime`, worktimeRouter());
app.use(`${BASE_PATH}/api/briefings`, briefingsRouter());
app.use(`${BASE_PATH}/api/automations`, automationsRouter());
app.use(`${BASE_PATH}/api`, sharingRouter());
app.use(`${BASE_PATH}/api`, sessionsRouter());
app.use(`${BASE_PATH}/api`, reviewRouter());
app.use(`${BASE_PATH}/api`, metatermRouter());
app.use(`${BASE_PATH}/api/visits`, visitsRouter());
app.use(`${BASE_PATH}/api/warp`, warpRouter());
app.use(`${BASE_PATH}/api/context`, contextRouter());
app.use(`${BASE_PATH}/api/instances`, instancesRouter());
app.use(`${BASE_PATH}/api/spaces`, requireAuth, spacesRouter({
  store: spaceStore, objects: spaceObjects, enabled: spacesEnabledFor, sharing: spacesSharingEnabledFor, onMemberChanged: recheckMirrorsForMember,
  caller: req => (req.user ? { kind: 'user', userId: req.user.id } : null),
  fileLink: (space, path) => `${FRONTEND_URL}${spaceFileLinkPath(BASE_PATH, space, path)}`,
}));
// Space file links, /termag/files/<space>/<path> (routes/spaceFiles.ts): a
// navigation, so behind the session cookie and the ALB's Okta default action,
// never under /api. Must stay ahead of the SPA fallback below.
app.use(`${BASE_PATH}${FILE_LINK_PREFIX}`, spaceFilesRouter({
  store: spaceStore, objects: spaceObjects, enabled: spacesEnabledFor, htmlEnabled: spacesHtmlLinksEnabledFor,
  userId: req => req.user?.id ?? null,
  signIn: authMode() === 'okta'
    ? undefined
    : req => new Promise((resolve, reject) => {
      if (!stashPostLoginReturn(req.session, BASE_PATH, req.originalUrl)) { resolve(null); return; }
      req.session.save(err => (err ? reject(err) : resolve(`${BASE_PATH}/auth/login`)));
    }),
}));
// Preview share links, /termag/p/<key> (routes/previewShares.ts):
// a navigation like a file link, so behind the
// session cookie and the ALB's Okta default action, ahead of the SPA fallback.
app.use(`${BASE_PATH}/p`, previewLinkRouter(BASE_PATH, {
  store: defaultPreviewShareRouteDeps.store,
  isCollaborator: defaultPreviewShareRouteDeps.isCollaborator,
  userId: req => req.user?.id ?? null,
  signIn: authMode() === 'okta'
    ? undefined
    : req => new Promise((resolve, reject) => {
      if (!stashPostLoginReturn(req.session, BASE_PATH, req.originalUrl)) { resolve(null); return; }
      req.session.save(err => (err ? reject(err) : resolve(`${BASE_PATH}/auth/login`)));
    }),
}));
app.use(`${BASE_PATH}/api`, previewSharesRouter());
// Every end of a PR link share edits its PR comment, on whichever orchestrator ended it (services/previewShareLinks.ts).
installPreviewShareLinkHooks();
// A PR a session reports opening is shared when its project says so (4c).
installAutoPreviewShares();
app.use(`${BASE_PATH}/api/ssh-keys`, sshKeysRouter());
app.use(`${BASE_PATH}/api/warm-pool`, warmPoolRouter());
app.use(`${BASE_PATH}/api`, workstreamsRouter());
app.use(`${BASE_PATH}/api`, spawnsRouter());
app.use(`${BASE_PATH}/api`, handoffsRouter());
app.use(`${BASE_PATH}/api`, collabRouter());
app.use(`${BASE_PATH}/api/flags`, featureFlagsRouter());
app.use(`${BASE_PATH}/api/credentials`, credentialsRouter());
app.use(`${BASE_PATH}/api/mcp-connectors`, mcpConnectorsRouter());
// Fetched by MCP authorization servers, so no session.
app.get(`${BASE_PATH}/oauth/client-metadata.json`, mcpClientMetadataHandler);
app.use(`${BASE_PATH}/api/github`, githubReposRouter());
app.use(`${BASE_PATH}/api/providers`, providersRouter());
app.use(`${BASE_PATH}/api`, prsRouter());
app.use(`${BASE_PATH}/api/push`, pushRouter());
// Admin surface: REST under /api/admin and the
// Streamable HTTP MCP server at /mcp/admin. Both behind requireAdmin. The MCP
// path audits per tool call inside the server, so requireAdmin's per-request
// REST audit is skipped there via `skipAudit`.
app.use(`${BASE_PATH}/api/admin`, adminRouter());
app.all(`${BASE_PATH}/mcp/admin`, (req, _res, next) => { req.skipAudit = true; next(); }, requireAdmin, rateLimit({ capacity: 60, perMinute: 120 }), (req, res) => { void handleAdminMcp(req, res); });

app.get(`${BASE_PATH}/health`, (_req, res) => {
  res.json({ status: 'ok' });
});

// Root-level liveness/readiness probe for container platforms whose default
// health check path is fixed and sits outside BASE_PATH. Unauthenticated and
// session-free by construction (the session middleware is mounted under
// BASE_PATH). Same body as /health so either can be pointed at.
app.get('/public/status', (_req, res) => {
  res.json({ status: 'ok' });
});

// --- Overlapping deploys (services/orchestratorLease.ts) ---
// With ORCHESTRATOR_LEASE=true two processes can overlap during a deploy: the
// newest holds the lease and does the singleton work, the one it displaced
// drains (services/orchestratorDrain.ts). Without it this process always
// serves, as before.
const leaseConfig = leaseConfigFromEnv(process.env);
let ecrBackfillStarted = false;

// Slack Socket Mode and the Discord gateway connect only on the lease holder
// (services/leaderOnly.ts). Slack's Web API client stays up everywhere.
const chatBots: LeaderOnly[] = [];
if (slackApp) {
  const app = slackApp;
  chatBots.push(leaderOnly({ name: 'SLACK', start: () => startSlackApp(app), stop: () => stopSlackApp(app) }));
}
if (process.env.DISCORD_TOKEN) {
  // A fresh client per start: a destroyed discord.js client is not reused.
  let discordClient: DiscordClient | null = null;
  chatBots.push(leaderOnly({
    name: 'DISCORD',
    start: () => { discordClient = createDiscordClient(); return startDiscordClient(discordClient); },
    stop: async () => { if (discordClient) await stopDiscordClient(discordClient); discordClient = null; },
  }));
}

// The host's Claude runner orchestrator stops when this process drains
// (services/claudeRunnerUnit.ts); only on the orchestrator image, lease on.
const runnerUnit = runnerUnitControlFromEnv(leaseConfig !== null);

// After a takeover the displaced process kept taking status writes until the
// load balancer moved; they are in session_statuses but not in this map. Read
// it again once the old process has closed its agents and browsers, and run
// no status timers before that (services/statusTakeover.ts).
const statusTakeover = leaseConfig ? createStatusTakeover({
  delayMs: leaseConfig.drainGraceMs + leaseConfig.drainBrowserDelayMs + 5_000,
  rehydrate: () => rehydrateStatuses(),
  setTimersSuspended: suspended => setStatusTimersSuspended(suspended),
}) : null;

function startLeaderWork(): void {
  setAgentRegistryDraining(false);
  if (statusTakeover) statusTakeover.serve();
  else setStatusTimersSuspended(false);
  for (const bot of chatBots) bot.set(true);
  void runnerUnit?.serve();
  startTmuxPoller().catch(err => console.error('[TMUX-POLLER] Failed to start:', err));
  startReviewSweep();
  startSpawnNudgeSweep();
  startHandoffSweep();
  startCollabNudgeSweep();
  startChatStatusSweep();
  startTokenUsageSampler();
  startProvisioningSweep();
  if (!ecrBackfillStarted) {
    ecrBackfillStarted = true;
    backfillBoxEcrPullPolicies().catch(err => console.error('[BOX] ECR pull policy backfill failed:', err));
    moveChatModelsToWorkflows()
      .then(n => { if (n) console.log(`[CHAT] moved ${n} project chat model(s) onto their workstreams`); })
      .catch(err => console.error('[CHAT] chat model move failed:', err));
  }
  startPowerSweep();
  startWarmPoolReconciler();
  startCloudSessionSweeps();
  startBoxUpdateSweep();
  startAskSweep();
  startBriefingScheduler();
  startAutomationScheduler();
  startLifecycleSweep();
  startPreviewShareSweep();
  startHostSampling();
  startPrIngester();
  startSegmentTracker();
  spacesSweeper.start();
  startSoftwareCollector();
}

function stopLeaderWork(): void {
  setAgentRegistryDraining(true);
  if (statusTakeover) statusTakeover.drain();
  else setStatusTimersSuspended(true);
  for (const bot of chatBots) bot.set(false);
  void runnerUnit?.drain();
  stopTmuxPoller();
  stopReviewSweep();
  stopSpawnNudgeSweep();
  stopHandoffSweep();
  stopCollabNudgeSweep();
  stopChatStatusSweep();
  stopTokenUsageSampler().catch(() => {});
  stopProvisioningSweep();
  stopPowerSweep();
  stopWarmPoolReconciler();
  stopCloudSessionSweeps();
  stopBoxUpdateSweep();
  stopAskSweep();
  stopBriefingScheduler();
  stopAutomationScheduler();
  stopLifecycleSweep();
  stopPreviewShareSweep();
  stopHostSampling();
  stopPrIngester().catch(() => {});
  stopSegmentTracker().catch(() => {});
  spacesSweeper.stop();
  stopSoftwareCollector().catch(() => {});
}

const closeSockets = (agents: boolean): number => {
  let n = 0;
  for (const client of wss.clients) {
    if (agentSockets.has(client) !== agents) continue;
    client.close(DRAIN_CLOSE_CODE, DRAIN_CLOSE_REASON);
    n++;
  }
  return n;
};

const drain = createDrain({
  graceMs: leaseConfig?.drainGraceMs ?? 0,
  browserDelayMs: leaseConfig?.drainBrowserDelayMs ?? 0,
  startLeaderWork,
  stopLeaderWork,
  closeAgents: () => closeSockets(true),
  closeBrowsers: () => closeSockets(false),
});

// Box-agent sockets, so the drain can close them before the browsers'.
const agentSockets = new WeakSet<WebSocket>();

let lease: OrchestratorLease | null = null;

// The load balancer's health check: 503 while this process is draining (or
// still starting), so new requests and WebSockets go to the serving one.
// /public/status stays a plain liveness probe.
app.get(`${BASE_PATH}/health/serving`, (_req, res) => {
  const serving = drain.isServing();
  res.status(serving ? 200 : 503).json({ status: serving ? 'serving' : 'draining' });
});

// Serve built frontend (production)
const frontendDist = join(__dirname, '../../frontend/dist');
// Sound Garden static SPA, served same-origin so the status-WS session cookie works.
// Must be registered before the BASE_PATH static mount + SPA fallback below.
app.use(`${BASE_PATH}/sound-garden`, express.static(join(__dirname, '../../sound-garden')));
// A missing /assets/ file or .map 404s instead of getting index.html (spaStatic).
app.use(`${BASE_PATH}/`, spaStatic(frontendDist));

// Final error middleware: anything forwarded via next(err) — asyncHandler-wrapped
// routes, body-parser rejecting malformed JSON — becomes a JSON { error }
// response instead of Express's HTML page or, for async rejections, a request
// that never completes. Must stay after every route/static mount above.
app.use(apiErrorHandler);

// --- WebSocket server for terminal streams and status push ---
const wss = new WebSocketServer({ noServer: true });

// Share session middleware with WebSocket upgrade
server.on('upgrade', (req, socket, head) => {
  // Reject a cross-origin handshake before touching the session, so a page on
  // another same-site origin can't open a terminal on the victim's ambient
  // cookie (see auth/wsOrigin.ts). The agent sends no Origin and passes here;
  // its bearer token is still checked downstream.
  if (!isAllowedUpgradeOrigin(req.headers.origin)) {
    console.warn(`[ws] rejected upgrade from disallowed origin: ${req.headers.origin}`);
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  // The CLI's sockets (/api/cli/v1/ws/*) carry the `termag login` credential
  // in the Authorization header and never a cookie, like the HTTP routes they
  // sit beside; see routes/cliWs.ts. A refusal is a plain HTTP answer.
  if (cliWsRoute(new URL(req.url ?? '', 'http://localhost').pathname, BASE_PATH)) {
    authenticateCliUpgrade(cliWsDeps, req, new URL(req.url ?? '', 'http://localhost'))
      .then((result) => {
        if ('error' in result) {
          // end(), not write()+destroy(): the client must read the status to
          // tell a dead credential (stop) from a network blip (retry).
          socket.end(refusalResponse(result));
          return;
        }
        upgradeUserIds.set(req, result.auth.user.id);
        wss.handleUpgrade(req, socket, head, (ws) => {
          // Frames are not requests: keep judging the credential while open.
          watchCliSocket(ws, cliWsDeps, result);
          wss.emit('connection', ws, req);
        });
      })
      .catch((err) => {
        console.error('[ws] CLI upgrade auth failed:', (err as Error).message);
        socket.end(refusalResponse({ status: 401, error: 'auth error' }));
      });
    return;
  }
  sessionMiddleware(req as express.Request, {} as express.Response, () => {
    upgradeUserId(req as express.Request).catch(() => null).then((userId) => {
      upgradeUserIds.set(req, userId);
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });
  });
});

const upgradeUserIds = new WeakMap<import('http').IncomingMessage, string | null>();

function sessionUserId(req: import('http').IncomingMessage): string | null {
  return upgradeUserIds.get(req) ?? null;
}

// Status push: track all connected status clients
// ownedBoxes: the client's boxes, id -> unix user, for the runner sessions of
// Claude Code cloud sessions, which are named after the box's unix user
// (services/claudeRunnerSpawn.ts, isOwnRunnerSessionStatus). Filled at
// connect and completed lazily for a box created since (ownedBoxUser).
// The shared scope (services/statusAudience.ts) is what reaches the client
// through sharing: chat frames by project, statuses by (box, session).
type StatusClientInfo = ScopeHolder & { unixUsername: string; ownedBoxes: Map<string, string | null>; boxCheckedAt: Map<string, number> };

/** A status as a collaborator gets it: no PR URL on the milestone or the review (see the fan-out below). */
function sharedStatusPayload(session: string, status: AgentStatus): string {
  return JSON.stringify({
    type: 'status', session, ...status,
    milestone: milestoneForSharedViewer(status.milestone),
    review: reviewForSharedViewer(status.review),
  });
}
const statusClients = new Map<WebSocket, StatusClientInfo>();
// A box without a known unix user yet (still provisioning, or a failed
// lookup) and a box that is not the client's both read as null; neither is
// final, so a null is re-checked after this long. A known user is kept.
const BOX_NULL_RECHECK_MS = 60_000;

/**
 * The unix user of one of this client's boxes, from the connect-time map or
 * a lookup for a box created since; a null answer (not theirs, or no user
 * reported yet) is kept only BOX_NULL_RECHECK_MS.
 */
async function ownedBoxUser(info: StatusClientInfo, instanceId: string, now = Date.now()): Promise<string | null> {
  const known = info.ownedBoxes.get(instanceId);
  if (known) return known;
  if (info.ownedBoxes.has(instanceId) && now - (info.boxCheckedAt.get(instanceId) ?? 0) < BOX_NULL_RECHECK_MS) return null;
  const box = await prismaIndex.instance.findFirst({ where: { id: instanceId, userId: info.userId }, select: { hostUnixUser: true } }).catch(() => null);
  info.ownedBoxes.set(instanceId, box?.hostUnixUser ?? null);
  info.boxCheckedAt.set(instanceId, now);
  return box?.hostUnixUser ?? null;
}

// Heartbeat every 25s so idle WebSockets stay alive through intermediaries
// (AWS ALB drops idle conns at 60s; Vite's dev proxy is similarly impatient).
// Browsers auto-respond to ws.ping() at the protocol level, so no frontend
// change needed. Mirrors the agent's own ping loop in agent/agent.js.
const WS_HEARTBEAT_MS = 25_000;

// Base64 of the 20 MiB image the per-user agent is willing to write to its
// clipboard mailbox. Anything larger is dropped before it reaches the agent.
const MAX_PASTE_IMAGE_B64_CHARS = 28 * 1024 * 1024;

function startHeartbeat(ws: WebSocket): void {
  let alive = true;
  ws.on('pong', () => { alive = true; });
  const hb = setInterval(() => {
    if (!alive) {
      try { ws.terminate(); } catch {}
      return;
    }
    alive = false;
    try { ws.ping(); } catch {}
  }, WS_HEARTBEAT_MS);
  ws.once('close', () => clearInterval(hb));
}

wss.on('connection', (ws, req) => {
  // A draining process takes no new sockets; the client redials and the load
  // balancer, which no longer sends it here, picks the serving process.
  if (!drain.isServing()) {
    ws.close(DRAIN_CLOSE_CODE, DRAIN_CLOSE_REASON);
    return;
  }
  startHeartbeat(ws);

  const url = new URL(req.url ?? '', `http://localhost`);
  const path = url.pathname;
  // From the session cookie, or on the CLI's paths from the bearer the upgrade judged.
  const loggedInUserId = sessionUserId(req);
  const cliRoute = cliWsRoute(path, BASE_PATH);

  // Terminal WebSocket: /termag/ws/terminal?session=username-project-agent
  // (the browser) or /termag/api/cli/v1/ws/terminal (the TUI's remote attach)
  if (path === `${BASE_PATH}/ws/terminal` || cliRoute === 'terminal') {
    if (!loggedInUserId) {
      ws.close(1008, 'login required');
      return;
    }

    const tmuxSession = url.searchParams.get('session');
    if (!tmuxSession) {
      ws.close(1008, 'session param required');
      return;
    }
    // The project id says what is attached; the session string is only
    // compared with the names rebuilt for that project (terminalSessionAccess).
    // There is no fallback that parses owner and project out of the session
    // string: every client has sent projectId since June 2026, and the parse
    // let a share on one project reach another's session, tmux reading `-t`
    // as a prefix and a pattern.
    const projectIdParam = url.searchParams.get('projectId');
    if (!projectIdParam) {
      ws.close(1008, 'project id required');
      return;
    }
    const workstreamParam = url.searchParams.get('workstream') || 'main';

    (async () => {
      const access = await terminalSessionAccess(loggedInUserId, projectIdParam, tmuxSession, workstreamParam);
      if ('refusal' in access) {
        console.log(`[TERMINAL] ${access.refusal}: ${tmuxSession} for project ${projectIdParam} (${workstreamParam})`);
        ws.close(1008, access.refusal);
        return;
      }
      const { project } = access;
      if (!access.isOwner) console.log(`[TERMINAL] Shared access: routing ${tmuxSession} for collaborator`);

      // Route via the project's box (if pinned) or the owner's legacy agent.
      const instanceId = project.instanceId;
      const agentConnected = instanceId
        ? isInstanceAgentConnected(instanceId)
        : isAgentConnected(project.userId);

      const refusal = terminalAttachRefusal(instanceId, await instanceStatus(instanceId), agentConnected, project);
      if (refusal?.kind === 'parked') {
        const { notice } = refusal;
        console.log(`[TERMINAL] Box ${instanceId} is ${notice.status}; refusing ${tmuxSession}`);
        ws.send(JSON.stringify(notice));
        ws.send(JSON.stringify({ type: 'output', data: `\r\n${notice.message}\r\n` }));
        ws.close(TERMINAL_BOX_PARKED_CLOSE_CODE, `box ${notice.status}`);
        return;
      }
      // A plain 1008 close: today's browser backs off and reattaches, which
      // lands once the project is ready.
      if (refusal?.kind === 'setup') {
        console.log(`[TERMINAL] Project ${project.id} setup is ${refusal.refusal.setupStatus}; refusing ${tmuxSession}`);
        ws.send(JSON.stringify({ type: 'output', data: `\r\n${refusal.refusal.message}\r\n` }));
        ws.close(1008, `project setup ${refusal.refusal.setupStatus}`);
        return;
      }
      if (refusal) {
        const where = instanceId ? `box ${instanceId}` : project.ownerUsername;
        console.log(`[TERMINAL] Agent not connected for ${where}`);
        ws.send(JSON.stringify({
          type: 'output',
          data: `\r\nAgent not connected${instanceId ? ' for this box' : ''}.\r\n`,
        }));
        ws.close(1008, 'agent not connected');
        return;
      }

      const initCols = parseInt(url.searchParams.get('cols') || '', 10) || 80;
      const initRows = parseInt(url.searchParams.get('rows') || '', 10) || 24;

      console.log(`[TERMINAL] Routing ${tmuxSession} via ${instanceId ? `instance ${instanceId}` : project.ownerUsername} (${initCols}x${initRows})`);
      try {
        const onData = (msg: any) => {
          if (ws.readyState === WebSocket.OPEN) {
            if (msg.type === 'terminal-data') {
              ws.send(JSON.stringify({ type: 'output', data: msg.data }));
            } else if (msg.type === 'terminal-exit') {
              ws.send(JSON.stringify({ type: 'exit' }));
            }
          }
        };
        const streamId = instanceId
          ? await requestInstanceTerminalStream(instanceId, { id: project.userId }, tmuxSession, initCols, initRows, onData)
          : await requestTerminalStream(project.userId, tmuxSession, initCols, initRows, onData);

        // A browser that left during the attach has already fired 'close', so
        // no listener below would ever tell the agent to drop its PTY.
        if (ws.readyState !== WebSocket.OPEN) {
          closeTerminalStream(streamId);
          return;
        }

        ws.on('message', (raw) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'input' && msg.data !== undefined) {
              sendTerminalInput(streamId, msg.data);
            } else if (msg.type === 'paste-image' && typeof msg.data === 'string') {
              if (msg.data.length <= MAX_PASTE_IMAGE_B64_CHARS) {
                sendTerminalPasteImage(streamId, msg.data);
              }
            } else if (msg.type === 'resize' && msg.cols && msg.rows) {
              sendTerminalResize(streamId, msg.cols, msg.rows);
            } else if (msg.type === 'mouse' && msg.enabled !== undefined) {
              sendTerminalMouse(streamId, msg.enabled);
            }
          } catch { /* ignore */ }
        });

        ws.on('close', () => {
          closeTerminalStream(streamId);
        });
      } catch (err) {
        console.error(`[TERMINAL] Agent routing failed for ${tmuxSession}:`, (err as Error).message);
        ws.send(JSON.stringify({ type: 'output', data: '\r\nFailed to connect through agent.\r\n' }));
        ws.close(1011, 'agent error');
      }
    })().catch((err) => {
      console.error(`[TERMINAL] Terminal routing failed:`, (err as Error).message);
      ws.close(1011, 'lookup error');
    });
    return;
  }

  // Browser pane WebSocket:
  // /termag/ws/browser?projectId=&workstream=&url=&width=&height=
  if (path === `${BASE_PATH}/ws/browser`) {
    handleBrowserPaneSocket(ws, url, loggedInUserId).catch((err) => {
      console.error('[BROWSER-PANE] socket failed:', (err as Error).message);
      try { ws.close(1011, 'lookup error'); } catch { /* already closed */ }
    });
    return;
  }

  // Status WebSocket: /termag/ws/status (the browser) or
  // /termag/api/cli/v1/ws/status (the TUI) — receives status push events
  if (path === `${BASE_PATH}/ws/status` || cliRoute === 'status') {
    if (!loggedInUserId) {
      ws.close(1008, 'login required');
      return;
    }

    prismaIndex.user.findUnique({ where: { id: loggedInUserId } }).then(async (user) => {
      if (!user) {
        ws.close(1008, 'unknown user');
        return;
      }

      // What reaches this user through sharing (services/statusAudience.ts).
      const scope = await loadSharedScope(user.id);
      const boxes = await prismaIndex.instance.findMany({ where: { userId: user.id }, select: { id: true, hostUnixUser: true } });
      const ownedBoxes = new Map(boxes.map(b => [b.id, b.hostUnixUser]));
      const checkedAt = Date.now();

      const clientInfo: StatusClientInfo = { ...scope, userId: user.id, unixUsername: user.unixUsername, sharedCheckedAt: checkedAt, ownedBoxes, boxCheckedAt: new Map(boxes.map(b => [b.id, checkedAt])) };
      statusClients.set(ws, clientInfo);
      console.log(`[STATUS] Client connected for ${user.unixUsername} (shared owners: [${scope.sharedOwners.join(',')}], total: ${statusClients.size})`);

      // Send current statuses for this user so the client starts with the right state.
      for (const [key, status] of getAllStatuses()) {
        const { session, instanceId } = parseStatusKey(key);
        const route = statusRoute(clientInfo, session, instanceId);
        if (route === 'own' || (route === 'runner' && isOwnRunnerSessionStatus(session, instanceId, ownedBoxes))) {
          ws.send(JSON.stringify({ type: 'status', session, ...status }));
        } else if (route === 'shared') {
          // The scope was read just now. Same stripping as the live fan-out.
          ws.send(sharedStatusPayload(session, status));
        }
      }

      // Application-level heartbeat. The protocol-level ping above keeps the
      // connection alive and lets the SERVER notice a dead browser, but browser
      // JavaScript cannot observe pings, so a page whose network silently died
      // (VPN drop = half-open TCP, no FIN ever arrives) sees an open, quiet
      // socket forever and keeps rendering stale statuses. A visible message on
      // the same cadence gives the client something to time out on.
      const appHb = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        try { ws.send(JSON.stringify({ type: 'heartbeat', ts: Date.now() })); } catch {}
      }, WS_HEARTBEAT_MS);
      ws.once('close', () => clearInterval(appHb));
    }).catch(() => {
      ws.close(1008, 'auth error');
    });


    ws.on('close', () => {
      statusClients.delete(ws);
      console.log(`[STATUS] Client disconnected (total: ${statusClients.size})`);
    });
    return;
  }

  // Agent WebSocket: /termag/ws/agent, Authorization: Bearer tmag_xxx (or the
  // legacy ?token=tmag_xxx, see auth/agentWsToken.ts)
  if (path === `${BASE_PATH}/ws/agent`) {
    agentSockets.add(ws);
    const presented = agentWsToken(req.headers, url);
    if ('refusal' in presented) {
      if (presented.refusal === QUERY_TOKEN_REFUSAL) {
        agentTokenForms.refused();
        console.warn('[AGENT-WS] refused a token in the query string (AGENT_WS_QUERY_TOKEN=false)');
      }
      ws.close(1008, presented.refusal);
      return;
    }
    const { token, form } = presented;
    holdFramesUntilReady(ws, async () => {
      const result = await validateAgentToken(token);
      if (!result) {
        ws.close(1008, 'invalid or revoked token');
        return;
      }
      // Only agent-scoped tokens may register as an agent. An admin token
      // that reached here would evict the user's real agent (agentRegistry
      // replaces the agent for the same key) — refuse instead.
      if (result.token.scope !== 'agent') {
        ws.close(1008, 'token scope does not permit agent connections');
        return;
      }
      // result.instance is null for legacy per-user tokens, non-null for
      // instance-bound tokens minted by POST /api/instances. result.user is
      // null for a warm-pool token whose box has no owner yet; registerAgent
      // closes the neither-one case with 1008.
      const who = { userId: result.user?.id ?? null, instanceId: result.instance?.id ?? null };
      const n = agentTokenForms.connected(ws, form, who);
      ws.once('close', () => agentTokenForms.closed(ws));
      if (form === 'query') {
        console.warn(`[AGENT-WS] agent for ${who.instanceId ? `instance ${who.instanceId}` : `user ${who.userId}`} sent its token in the query string (${n} query-form connects since start); update its agent`);
      }
      registerAgent(result.user, ws, result.instance);
    }).catch(() => {
      ws.close(1008, 'auth error');
    });
    return;
  }

  ws.close(1008, 'unknown path');
});

// Push status changes to all connected status clients
setStatusChangeCallback((sessionName: string, instanceId: string | null) => {
  const status = getStatus(sessionName, instanceId);
  const payload = JSON.stringify({ type: 'status', session: sessionName, ...status });
  // A collaborator gets only the sessions of the projects shared with them
  // (statusRoute, services/statusAudience.ts), and those without the
  // milestone's PR URL (the prompt still works) or the review's: the owner
  // gets the full payload. The stripping dates from when this fan-out went to
  // anyone sharing any project with the owner; GET /api/sessions carries the
  // URL for the projects a collaborator has.
  const sharedPayload = status.milestone || status.review ? sharedStatusPayload(sessionName, status) : payload;
  // Every fan-out, so a debug line (TERMAG_DEBUG=STATUS): it was the single
  // largest source of journal records shipped to Observability.
  debugLog('STATUS', () => `Push ${sessionName} to ${statusClients.size} clients`);
  for (const [client, clientInfo] of statusClients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    switch (statusRoute(clientInfo, sessionName, instanceId)) {
      case 'own':
        client.send(payload);
        break;
      case 'shared':
      case 'recheck':
        // In the scope, or a sharer's session outside it (maybe a workstream
        // made since it was read): either way only a fresh scope decides.
        sendThroughShare(clientInfo, () => statusRoute(clientInfo, sessionName, instanceId) === 'shared', () => {
          if (client.readyState === WebSocket.OPEN) client.send(sharedPayload);
        });
        break;
      case 'runner':
        // A cloud session's runner on one of this client's boxes, named after
        // the box's unix user. The box map may lack a box created since the
        // client connected, or hold a null for one still provisioning; the
        // lookup fills it in, and a null is re-checked after a minute.
        void ownedBoxUser(clientInfo, instanceId!).then(hostUser => {
          if (hostUser && isOwnRunnerSessionStatus(sessionName, instanceId, clientInfo.ownedBoxes) && client.readyState === WebSocket.OPEN) client.send(payload);
        });
        break;
    }
  }
});

// Cloud-session changes (a spawn outcome, a box's started/title/ended report,
// a lost sweep) go to the owner's status clients only: sessions are personal,
// not shared with project collaborators. The browser refetches the list.
// Simple-UI chat events (services/chatRunner.ts) carry prompts and file
// contents, so they go to the project's owner and the users this project is
// shared with (mayReceiveChat), never by the session-name prefix.
setChatPushCallback(({ owner, payload }) => {
  const body = JSON.stringify(payload);
  const chat = { owner, projectId: payload.projectId };
  for (const [client, clientInfo] of statusClients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (clientInfo.unixUsername === owner) client.send(body);
    else sendThroughShare(clientInfo, () => mayReceiveChat(chat, clientInfo), () => {
      if (client.readyState === WebSocket.OPEN) client.send(body);
    });
  }
});

// A share accepted, revoked or left (routes/sharing.ts): the sockets it
// touches re-read their scope now, after any read already in flight, and get
// the current statuses it newly admits and a `status-gone` for each session it
// drops (shareChangeFrames), so an accepted share shows on a page that is
// already open and a revoked one stops, and clears, at once. Pushes in the
// meantime wait for the read (sendThroughShare).
setShareChangeCallback((change) => {
  for (const [client, clientInfo] of statusClients) {
    if (!shareChangeTouches(change, clientInfo)) continue;
    const before = clientInfo.sharedStatusKeys;
    void startSharedRefresh(clientInfo, clientInfo.sharedRefresh).then(() => {
      if (client.readyState !== WebSocket.OPEN) return;
      const { admitted, gone } = shareChangeFrames(before, clientInfo.sharedStatusKeys, getAllStatuses());
      for (const [key, status] of admitted) client.send(sharedStatusPayload(parseStatusKey(key).session, status));
      for (const key of gone) client.send(JSON.stringify({ type: 'status-gone', ...parseStatusKey(key) }));
    });
  }
});
startChatRelay();
// Every process: a run's turn ends on whichever process relays its box.
startAutomationCompletion();

// One of this user's projects or boxes was made, renamed, archived, powered or
// terminated (the browser, the CLI, a spawn, a sweep): their tabs refetch that
// list. Owner only.
// A burst (box, project, then workstream within seconds) is one reload per
// half second per list, not one per write.
setWorkspaceChangeCallback(coalesceWorkspaceChanges((ownerId, what) => {
  const payload = JSON.stringify({ type: 'workspace', what });
  for (const [client, clientInfo] of statusClients) {
    if (client.readyState === WebSocket.OPEN && clientInfo.userId === ownerId) client.send(payload);
  }
}, 500));
// Every project, workstream, workflow or share write that changes the list
// tells its owner and collaborators, whichever path made it.
installWorkspaceWriteNotifier(prismaIndex);

setCloudSessionChangeCallback((owner, sessionId) => {
  const payload = JSON.stringify({ type: 'claude-session', sessionId, at: new Date().toISOString() });
  for (const [client, clientInfo] of statusClients) {
    if (client.readyState === WebSocket.OPEN && clientInfo.unixUsername === owner.unixUsername) client.send(payload);
  }
});

// --- Start ---
// The running commit is read now, before a checkout update can move HEAD
// under a process still running the old code.
void termagVersion().then(v => console.log(`[VERSION] termag ${v.sha?.slice(0, 12) ?? 'unknown'} (${v.source})`));

// Status is hydrated before listening, so the first /ws/status client already
// gets the pre-restart pills. A database error starts with an empty map. With
// the lease, hydrate arms no timers: they start once this process serves and
// has re-read the table (services/statusTakeover.ts).
if (leaseConfig) setStatusTimersSuspended(true);
let stopProjectClone: (() => void) | null = null;
let stopChatGate: (() => void) | null = null;
hydrateStatuses()
  .then(n => console.log(`[STATUS] hydrated ${n} session status(es) from session_statuses`))
  .catch(err => console.error('[STATUS] hydrate failed, starting empty:', (err as Error).message))
  .finally(() => server.listen(PORT, BIND_HOST, () => {
  console.log(`termag backend running on ${BIND_HOST ?? '*'}:${PORT} at ${BASE_PATH}`);
  stopProjectClone = startProjectClone();
  stopChatGate = startChatGate();
  startAskReplies();
  startAskQueue();
  startHumanActivityTracker();
  startWarpSampler();
  startContextSampler();
  if (leaseConfig) {
    const { holderId, label } = newHolder();
    lease = new OrchestratorLease({
      store: prismaLeaseStore, holderId, label, config: leaseConfig,
      onServe: () => drain.serve(),
      onDrain: () => drain.drain(),
    });
    lease.start().catch(err => console.error('[LEASE] start failed:', err));
  } else {
    drain.serve();
  }
  initFeatureFlags().catch(err => console.error('[FLAGS] init failed:', err));
  // OpenTelemetry metrics and logs, when there is somewhere to send them (services/otel.ts).
  if (initOtel()) registerSpawnGauges();
  syncAdminBootstrap().catch(err => console.error('[ADMIN] bootstrap failed:', err));
}));

function shutdown() {
  console.log('termag shutting down...');
  lease?.stop();
  stopProjectClone?.();
  stopChatGate?.();
  stopPowerSweep();
  stopProvisioningSweep();
  stopTmuxPoller();
  stopReviewSweep();
  stopChatStatusSweep();
  stopHumanActivityTracker();
  stopWarpSampler().catch(() => {});
  stopContextSampler().catch(() => {});
  stopTokenUsageSampler().catch(() => {});
  stopWarmPoolReconciler();
  stopCloudSessionSweeps();
  stopBoxUpdateSweep();
  stopAskSweep();
  stopAskReplies();
  stopAskQueue();
  stopBriefingScheduler();
  stopLifecycleSweep();
  stopPreviewShareSweep();
  closeFeatureFlags().catch(() => {});
  shutdownOtel().catch(() => {});
  // Close all WebSocket connections so the process can exit. A process that
  // was displaced (another one serves) closes with the drain code, which
  // agents and browsers redial at once.
  const displaced = leaseConfig !== null && !drain.isServing();
  for (const client of wss.clients) {
    if (displaced) client.close(DRAIN_CLOSE_CODE, DRAIN_CLOSE_REASON);
    else client.close(1001, 'server shutting down');
  }
  wss.close();
  server.close(() => process.exit(0));
  // Force exit after 5 seconds if graceful shutdown hangs
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Prevent Slack Socket Mode errors from crashing the process
process.on('uncaughtException', (err) => {
  console.error('[WARN] Uncaught exception (staying alive):', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[WARN] Unhandled rejection (staying alive):', reason);
});
