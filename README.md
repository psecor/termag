# termag

A workspace manager for running multiple AI coding agents in parallel. Provides a web UI for managing projects, viewing agent terminals, choosing an agent runtime per project, and monitoring usage, with Slack integration for remote control.

## What it does

Each project gets a paired set of tmux sessions — an **agent** pane (where Codex, Claude Code, or other agents run) and a **ctrl** pane (a regular terminal for commands the agent can't run, like sudo or interactive auth). The web UI renders both terminals side-by-side with xterm.js and shows real-time agent status.

### Key features

- **Multi-project management** — create, rename, archive projects; each gets its own tmux sessions and working directory
- **Live terminal streaming** — xterm.js terminals connected via WebSocket to server-side PTYs attached to tmux
- **Per-project agent choice** — choose `Codex` or `Claude` when creating a project, with a persisted per-user default
- **Agent status tracking** — Claude Code hooks and Codex app-server status report working/waiting/idle state; shown as green/yellow/red indicators and a hyperspace animation that speeds up with activity
- **Usage dashboard** — tracks API token usage and cost with a thermometer gauge (today vs 14-day trailing median) and expandable 30-day/7-day histograms
- **Slack integration** — `/t` commands to view and control terminals from Slack; emoji reactions to respond to numbered prompts (e.g. react with :one: to send `1`)
- **Slack notifications** — automatic pane capture posted to Slack when an agent needs input, with reaction hints for quick response
- **Per-user agent architecture** — each user's agent runs as their unix user, handling tmux and filesystem operations with proper permissions
- **Google OAuth** — multi-user authentication mapped to unix accounts

## Architecture

```
Browser (React + xterm.js)
  ↕ WebSocket
Express server (port 3040)
  ├── REST API (projects, status, usage, auth)
  ├── WebSocket: terminal streams, status push
  ├── Slack Bolt (Socket Mode)
  └── PostgreSQL (Prisma ORM)
  ↕ WebSocket
Per-user agent (node agent.js)
  ├── node-pty → tmux attach
  └── Codex bridge processes (per Codex-backed agent session)
```

## Project structure

```
backend/          Express + TypeScript server
  src/
    routes/       REST endpoints (projects, status, usage)
    services/     tmux, status, agent registry
    slack/        Slack bot (events, formatting, LTS relay, home view)
    middleware/   auth
  prisma/         schema + migrations
frontend/         React 18 + Vite
  src/
    components/   Terminal, ProjectControl, UsageMini, Hyperspace
    contexts/     AuthContext, ProjectContext
    services/     API client
agent/            Per-user agent (plain JS, no build step)
relay/            Chrome tab capture relay (runs on laptop)
deploy/           Systemd units, setup docs, hook configs
```

## Quick start

See [deploy/setup.md](deploy/setup.md) for full setup instructions.

```bash
# Build
cd backend && npm install && npm run build
cd ../frontend && npm install && npm run build

# Run
sudo systemctl start termag          # main server
systemctl --user start termag-agent  # per-user agent
```

## Configuration

All configuration is via environment variables in `backend/.env`. See `.env.example` for the full list.

Key variables:
- `DATABASE_URL` — PostgreSQL connection string
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — OAuth credentials
- `SESSION_SECRET` — Express session secret
- `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET` — Slack bot
- `ALLOWED_USERS` — comma-separated `email:unixuser` pairs

## Agent providers

`termag` now persists the selected agent provider on each `agent` workflow.

- `codex` projects launch the managed Codex bridge and start `codex --remote` in the `*-agent` tmux pane
- `claude` projects keep the existing Claude startup path
- each user also has a saved `defaultAgentProvider`, used to initialize the create-project form

The UI lets you:
- choose `Codex` or `Claude` when creating a new project
- change your default agent provider in the sidebar
- see the current provider in the project list (`CX` / `CL`)
