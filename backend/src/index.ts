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
// import { workTerminalsRouter } from './routes/workTerminals'; // removed — work terminals feature dropped
import { statusRouter } from './routes/status';
import { browserRouter } from './routes/browser';
import { attachTerminal } from './services/terminal';
import { setStatusChangeCallback, getStatus } from './services/status';
import { createSlackApp, startSlackApp } from './slack/app';
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

const sessionMiddleware = session({
  store: new PgSession({ conString: process.env.DATABASE_URL }),
  secret: process.env.SESSION_SECRET ?? 'dev-secret',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
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
// app.use(`${BASE_PATH}/api/work-terminals`, workTerminalsRouter()); // removed
app.use(`${BASE_PATH}/api/status`, statusRouter());
app.use(`${BASE_PATH}/api/browser`, browserRouter());

app.get(`${BASE_PATH}/health`, (_req, res) => {
  res.json({ status: 'ok' });
});

// --- Slack Bot + LTS ---
let slackClient: import('@slack/web-api').WebClient | null = null;

if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
  const slackApp = createSlackApp();
  slackClient = slackApp.client;

  const refreshAllHomeViews = async () => {
    const viewers = getActiveHomeViewers();
    await Promise.all([...viewers].map(uid => publishHomeView(slackApp.client, uid).catch(() => {})));
  };

  // LTS API on the same Express app (different path prefix)
  if (process.env.CAPTURE_API_SECRET) {
    app.use('/lts', ltsRouter(
      slackApp.client,
      (userId: string) => publishHomeView(slackApp.client, userId),
      refreshAllHomeViews,
    ));
  }

  // Start Slack after Express is listening
  startSlackApp(slackApp).catch(err => console.error('[SLACK] Failed:', err));
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

// Status push: track all connected status clients
const statusClients = new Set<WebSocket>();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '', `http://localhost`);
  const path = url.pathname;

  // Terminal WebSocket: /termag/ws/terminal?session=username-project-agent
  if (path === `${BASE_PATH}/ws/terminal`) {
    const sessionName = url.searchParams.get('session');
    if (!sessionName) {
      ws.close(1008, 'session param required');
      return;
    }
    attachTerminal(sessionName, ws);
    return;
  }

  // Status WebSocket: /termag/ws/status — receives status push events
  if (path === `${BASE_PATH}/ws/status`) {
    statusClients.add(ws);
    ws.on('close', () => statusClients.delete(ws));
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
  for (const client of statusClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
});

// --- Start ---
server.listen(PORT, () => {
  console.log(`termag backend running on port ${PORT} at ${BASE_PATH}`);
});

function shutdown() {
  console.log('termag shutting down...');
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
