import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import passport from 'passport';
import { join } from 'path';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { parse as parseCookie } from 'querystring';

import { configurePassport, authRouter } from './routes/auth';
import { projectsRouter } from './routes/projects';
import { statusRouter } from './routes/status';
import { browserRouter } from './routes/browser';
import { agentTokensRouter } from './routes/agentTokens';
import { usageRouter } from './routes/usage';
import { worktimeRouter } from './routes/worktime';
import { sharingRouter } from './routes/sharing';
// import { attachTerminal } from './services/terminal'; // removed — all terminals route through agent
import { setStatusChangeCallback, getStatus, getAllStatuses } from './services/status';
import { createSlackApp, startSlackApp } from './slack/app';
import { createDiscordClient, startDiscordClient } from './discord/app';
import { validateAgentToken } from './routes/agentTokens';
import {
  registerAgent, isAgentConnected, requestTerminalStream,
  sendTerminalInput, sendTerminalResize, sendTerminalMouse, closeTerminalStream,
} from './services/agentRegistry';
import { PrismaClient } from '@prisma/client';
import { startTmuxPoller, stopTmuxPoller } from './services/tmuxPoller';
import { startHumanActivityTracker, stopHumanActivityTracker } from './services/humanActivity';

const prismaIndex = new PrismaClient();
import { ltsRouter } from './slack/lts';
import { publishHomeView } from './slack/homeView';
import { getActiveHomeViewers } from './slack/events';

const app = express();
const server = createServer(app);
const PgSession = connectPgSimple(session);

const BASE_PATH = process.env.BASE_PATH ?? '';
const PORT = parseInt(process.env.PORT ?? '3040', 10);
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173';

// --- Middleware ---
app.set('trust proxy', 1);
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json());

// --- LTS API (mounted before session/passport — uses its own bearer auth) ---
let slackClient: import('@slack/web-api').WebClient | null = null;
let slackApp: ReturnType<typeof createSlackApp> | null = null;

if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
  slackApp = createSlackApp();
  slackClient = slackApp.client;

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

const sessionMiddleware = session({
  store: new PgSession({ conString: process.env.DATABASE_URL }),
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

app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

configurePassport();

// --- Routes ---
app.use(`${BASE_PATH}/auth`, authRouter());
app.use(`${BASE_PATH}/api/projects`, projectsRouter());
app.use(`${BASE_PATH}/api/status`, statusRouter());
app.use(`${BASE_PATH}/api/browser`, browserRouter());
app.use(`${BASE_PATH}/api/agent-tokens`, agentTokensRouter());
app.use(`${BASE_PATH}/api/usage`, usageRouter());
app.use(`${BASE_PATH}/api/worktime`, worktimeRouter());
app.use(`${BASE_PATH}/api`, sharingRouter());

app.get(`${BASE_PATH}/health`, (_req, res) => {
  res.json({ status: 'ok' });
});

// --- Slack Bot ---
if (slackApp) {
  startSlackApp(slackApp).catch(err => console.error('[SLACK] Failed:', err));
}

// --- Discord Bot ---
if (process.env.DISCORD_TOKEN) {
  const discordClient = createDiscordClient();
  startDiscordClient(discordClient).catch(err => console.error('[DISCORD] Failed:', err));
}

// Serve built frontend (production)
const frontendDist = join(__dirname, '../../frontend/dist');
app.use(`${BASE_PATH}/`, express.static(frontendDist));
app.get(`${BASE_PATH}/*`, (_req, res) => {
  res.sendFile(join(frontendDist, 'index.html'));
});

// --- WebSocket server for terminal streams and status push ---
const wss = new WebSocketServer({ noServer: true });

// Share session middleware with WebSocket upgrade
server.on('upgrade', (req, socket, head) => {
  sessionMiddleware(req as express.Request, {} as express.Response, () => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });
});

function sessionUserId(req: import('http').IncomingMessage): string | null {
  const sessionUser = (req as any).session?.passport?.user;
  return typeof sessionUser === 'string' && sessionUser ? sessionUser : null;
}

function sessionBelongsToUser(sessionName: string, unixUsername: string): boolean {
  return sessionName === unixUsername || sessionName.startsWith(`${unixUsername}-`);
}

// Status push: track all connected status clients
const statusClients = new Map<WebSocket, { unixUsername: string; sharedOwnerUsernames: string[] }>();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '', `http://localhost`);
  const path = url.pathname;
  const loggedInUserId = sessionUserId(req);

  // Terminal WebSocket: /termag/ws/terminal?session=username-project-agent
  if (path === `${BASE_PATH}/ws/terminal`) {
    if (!loggedInUserId) {
      ws.close(1008, 'login required');
      return;
    }

    const tmuxSession = url.searchParams.get('session');
    if (!tmuxSession) {
      ws.close(1008, 'session param required');
      return;
    }

    // Try to route through user-agent if one is connected
    // Extract username from session name (format: username-project-role)
    const dashIdx = tmuxSession.indexOf('-');
    const username = dashIdx > 0 ? tmuxSession.substring(0, dashIdx) : null;

    if (!username) {
      ws.close(1008, 'invalid session name');
      return;
    }

    prismaIndex.user.findUnique({ where: { unixUsername: username } }).then(async (user) => {
      if (!user) {
        console.log(`[TERMINAL] No user found for username: ${username}`);
        ws.send(JSON.stringify({ type: 'output', data: `\r\nNo termag user "${username}"\r\n` }));
        ws.close(1008, 'unknown user');
        return;
      }

      // Allow owner directly; for others, check if they have a share on the project
      if (user.id !== loggedInUserId) {
        // Parse projectName from session: username-projectName-role
        const afterUsername = tmuxSession.substring(dashIdx + 1);
        const lastDash = afterUsername.lastIndexOf('-');
        const projectName = lastDash > 0 ? afterUsername.substring(0, lastDash) : null;

        let allowed = false;
        if (projectName) {
          const project = await prismaIndex.project.findFirst({
            where: { userId: user.id, name: projectName },
          });
          if (project) {
            const share = await prismaIndex.projectShare.findUnique({
              where: { projectId_userId: { projectId: project.id, userId: loggedInUserId } },
            });
            if (share) allowed = true;
          }
        }

        if (!allowed) {
          ws.close(1008, 'session forbidden');
          return;
        }
        console.log(`[TERMINAL] Shared access: routing ${tmuxSession} for collaborator`);
      }

      if (!isAgentConnected(user.id)) {
        console.log(`[TERMINAL] Agent not connected for ${user.unixUsername}`);
        ws.send(JSON.stringify({ type: 'output', data: '\r\nAgent not connected. Run the termag-agent on your account first.\r\n' }));
        ws.close(1008, 'agent not connected');
        return;
      }

      const initCols = parseInt(url.searchParams.get('cols') || '', 10) || 80;
      const initRows = parseInt(url.searchParams.get('rows') || '', 10) || 24;

      console.log(`[TERMINAL] Routing ${tmuxSession} through agent for ${user.unixUsername} (${initCols}x${initRows})`);
      try {
        const streamId = await requestTerminalStream(user.id, tmuxSession, initCols, initRows, (msg) => {
          if (ws.readyState === WebSocket.OPEN) {
            if (msg.type === 'terminal-data') {
              ws.send(JSON.stringify({ type: 'output', data: msg.data }));
            } else if (msg.type === 'terminal-exit') {
              ws.send(JSON.stringify({ type: 'exit' }));
            }
          }
        });

        ws.on('message', (raw) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'input' && msg.data !== undefined) {
              sendTerminalInput(user.id, streamId, msg.data);
            } else if (msg.type === 'resize' && msg.cols && msg.rows) {
              sendTerminalResize(user.id, streamId, msg.cols, msg.rows);
            } else if (msg.type === 'mouse' && msg.enabled !== undefined) {
              sendTerminalMouse(user.id, streamId, msg.enabled);
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
    }).catch((err) => {
      console.error(`[TERMINAL] User lookup failed:`, (err as Error).message);
      ws.close(1011, 'lookup error');
    });
    return;
  }

  // Status WebSocket: /termag/ws/status — receives status push events
  if (path === `${BASE_PATH}/ws/status`) {
    if (!loggedInUserId) {
      ws.close(1008, 'login required');
      return;
    }

    prismaIndex.user.findUnique({ where: { id: loggedInUserId } }).then(async (user) => {
      if (!user) {
        ws.close(1008, 'unknown user');
        return;
      }

      // Find owner usernames for projects shared with this user
      const shares = await prismaIndex.projectShare.findMany({
        where: { userId: user.id },
        include: { project: { include: { user: { select: { unixUsername: true } } } } },
      });
      const sharedOwnerUsernames = [...new Set(shares.map(s => s.project.user.unixUsername))];

      statusClients.set(ws, { unixUsername: user.unixUsername, sharedOwnerUsernames });
      console.log(`[STATUS] Client connected for ${user.unixUsername} (shared owners: [${sharedOwnerUsernames.join(',')}], total: ${statusClients.size})`);

      // Send current statuses for this user so the client starts with the right state
      for (const [session, status] of getAllStatuses()) {
        if (sessionBelongsToUser(session, user.unixUsername) ||
            sharedOwnerUsernames.some(owner => sessionBelongsToUser(session, owner))) {
          ws.send(JSON.stringify({ type: 'status', session, ...status }));
        }
      }
    }).catch(() => {
      ws.close(1008, 'auth error');
    });


    ws.on('close', () => {
      statusClients.delete(ws);
      console.log(`[STATUS] Client disconnected (total: ${statusClients.size})`);
    });
    return;
  }

  // Agent WebSocket: /termag/ws/agent?token=tmag_xxx
  if (path === `${BASE_PATH}/ws/agent`) {
    const token = url.searchParams.get('token');
    if (!token) {
      ws.close(1008, 'token param required');
      return;
    }
    validateAgentToken(token).then(user => {
      if (!user) {
        ws.close(1008, 'invalid or revoked token');
        return;
      }
      registerAgent(user, ws);
    }).catch(() => {
      ws.close(1008, 'auth error');
    });
    return;
  }

  ws.close(1008, 'unknown path');
});

// Push status changes to all connected status clients
setStatusChangeCallback((sessionName: string) => {
  const payload = JSON.stringify({
    type: 'status',
    session: sessionName,
    ...getStatus(sessionName),
  });
  console.log(`[STATUS] Push ${sessionName} to ${statusClients.size} clients`);
  for (const [client, clientInfo] of statusClients) {
    if (client.readyState === WebSocket.OPEN) {
      if (sessionBelongsToUser(sessionName, clientInfo.unixUsername) ||
          clientInfo.sharedOwnerUsernames.some(owner => sessionBelongsToUser(sessionName, owner))) {
        client.send(payload);
      }
    }
  }
});

// --- Start ---
server.listen(PORT, () => {
  console.log(`termag backend running on port ${PORT} at ${BASE_PATH}`);
  startTmuxPoller().catch(err => console.error('[TMUX-POLLER] Failed to start:', err));
  startHumanActivityTracker();
});

function shutdown() {
  console.log('termag shutting down...');
  stopTmuxPoller();
  stopHumanActivityTracker();
  // Close all WebSocket connections so the process can exit
  for (const client of wss.clients) {
    client.close(1001, 'server shutting down');
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
