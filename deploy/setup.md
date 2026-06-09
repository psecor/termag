# termag setup

> **Just want to add a user to a running termag instance?** Skip this whole
> document and read [§ Per-user agent against an existing instance](#per-user-agent-against-an-existing-instance) below.
> You don't need Postgres, Apache, OAuth, or any of the build steps — just the
> agent piece.

## Where to clone the repo

Clone termag into `~/src/termag/` (or any path you like) — **not into
`~/termag/`**. Termag creates project working dirs at
`~/termag/projects/<name>/` for each user, and putting the repo at
`~/termag/` will nest those projects inside the repo's git tree (breaks
git-init for new projects, plus general path confusion).

## Prerequisites

- Node.js 20+
- PostgreSQL 14+
- Apache with mod_proxy (or another reverse proxy)
- tmux 3.0+
- Google OAuth credentials (for web login)
- Slack app (optional, for /t commands and notifications)
- Discord bot (optional, mirrors Slack /t commands)

## 1. Database

```bash
createdb -U <db-user> termag
cd backend
cp .env.example .env
# fill in .env (see .env.example for all variables)
npm install
npm run db:migrate:dev
```

If you are upgrading an existing install rather than creating a fresh database,
apply migrations and regenerate Prisma before restarting:

```bash
cd backend
npx prisma generate
```

Create the session table for connect-pg-simple:
```sql
psql -U <db-user> -d termag -c "
CREATE TABLE \"session\" (
  \"sid\" varchar NOT NULL COLLATE \"default\",
  \"sess\" json NOT NULL,
  \"expire\" timestamp(6) NOT NULL
) WITH (OIDS=FALSE);
ALTER TABLE \"session\" ADD CONSTRAINT \"session_pkey\" PRIMARY KEY (\"sid\");
CREATE INDEX \"IDX_session_expire\" ON \"session\" (\"expire\");
"
```

## 2. Build

```bash
cd backend && npm install && npm run build
cd ../frontend && npm install && npm run build
```

## 3. Apache

Add to your VirtualHost (requires `a2enmod proxy proxy_http proxy_wstunnel`):

```apache
# WebSocket must come before the regular ProxyPass
ProxyPass        /termag/ws  ws://localhost:3040/termag/ws
ProxyPassReverse /termag/ws  ws://localhost:3040/termag/ws
ProxyPass        /termag     http://localhost:3040/termag
ProxyPassReverse /termag     http://localhost:3040/termag
```

## 4. Systemd services

### Main server (runs as root or a service user)

```bash
sudo cp deploy/termag.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now termag
```

### Per-user agent (runs as each user)

The agent handles tmux, PTY, and filesystem operations on behalf of each
user. Each user runs their own agent under `systemctl --user`. Detailed
walkthrough in the next section.

## Per-user agent against an existing instance

Use this path when the backend is already deployed (by you or someone
else) and you just want to add a new user to it. You skip Postgres,
Apache, OAuth, frontend builds, and Slack/Discord — everything except
the per-user agent.

### Operator setup (admin of the running instance)

1. Add the new user to `ALLOWED_USERS` in `backend/.env` —
   `email@example.com:unixuser` — and restart the main server:
   ```bash
   sudo systemctl restart termag
   ```
2. Enable lingering for that unix user so their agent runs without an
   active login:
   ```bash
   sudo loginctl enable-linger <unixuser>
   ```

### What the new user does

Replace `<termag-host>` with the public domain (e.g.
`termag.example.com`) and use `wss://` for remote, or `ws://localhost:3040`
if running on the same host as the backend.

```bash
# 1. Sign into https://<termag-host>/termag in a browser, then
#    sidebar → Agent Tokens → create one, copy it.

# 2. Clone the repo. NOT into ~/termag/ — pick anywhere else.
git clone https://github.com/psecor/termag.git ~/src/termag

# 3. Install only the agent dependencies (node-pty has a native build).
cd ~/src/termag/agent
npm install

# 4. Config file.
cp agent.config.example.json agent.config.json
# Edit agent.config.json — set termag_url and token.
#   termag_url: ws://localhost:3040/termag/ws/agent  (same host)
#               wss://<termag-host>/termag/ws/agent   (remote)

# 5. Install the persistent agent service. See platform sections below
#    (§ Linux: systemd or § macOS: launchd) for the exact commands.

# 6. Wire up Claude Code hooks. REQUIRED for status indicators to work
#    with the Claude provider — without this, project status dots stay
#    grey forever even though the agent and terminals are fine.
#    AMI-provisioned boxes already have this baked into
#    ~/.claude/settings.json (see packer/scripts/setup.sh). Only do this
#    by hand for non-baked installs (e.g. macOS). See deploy/claude-hooks.md.
```

### Step 5 on Linux (systemd)

```bash
mkdir -p ~/.config/systemd/user
cp ~/src/termag/deploy/termag-agent.service ~/.config/systemd/user/
# The unit uses %h (home) and assumes the clone at ~/src/termag/. Edit
# ExecStart if you cloned somewhere else.
systemctl --user daemon-reload
systemctl --user enable --now termag-agent
journalctl --user -u termag-agent -f   # confirm it connects
```

The operator should also run `sudo loginctl enable-linger <unixuser>` so the
agent keeps running without an active login session.

### Step 5 on macOS (launchd)

macOS doesn't have systemd. Use a `launchd` LaunchAgent — same idea,
different config format. Lingering isn't needed: LaunchAgents run for
the logged-in user automatically and you basically never log out of a
personal laptop.

First find your node binary path (the plist needs an absolute path):

```bash
which node
# /opt/homebrew/bin/node   on Apple Silicon Homebrew
# /usr/local/bin/node      on Intel Homebrew
# If you use nvm, point at a fully resolved path or write a wrapper script.
```

Create `~/Library/LaunchAgents/io.termag.agent.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>io.termag.agent</string>

    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/node</string>
        <string>/Users/YOURUSER/src/termag/agent/agent.js</string>
        <string>/Users/YOURUSER/src/termag/agent/agent.config.json</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>5</integer>

    <key>StandardOutPath</key>
    <string>/Users/YOURUSER/Library/Logs/termag-agent.log</string>

    <key>StandardErrorPath</key>
    <string>/Users/YOURUSER/Library/Logs/termag-agent.log</string>
</dict>
</plist>
```

Replace `YOURUSER` with your Mac username and adjust the node path.
`RunAtLoad=true` plus `KeepAlive=true` is the equivalent of systemd's
`Restart=always`.

Load and tail logs:

```bash
launchctl load ~/Library/LaunchAgents/io.termag.agent.plist
tail -f ~/Library/Logs/termag-agent.log   # confirm it connects
```

Common operations:

| Linux                                          | macOS                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| `systemctl --user restart termag-agent`        | `launchctl kickstart -k gui/$(id -u)/io.termag.agent`              |
| `systemctl --user stop termag-agent`           | `launchctl unload ~/Library/LaunchAgents/io.termag.agent.plist`    |
| `journalctl --user -u termag-agent -f`         | `tail -f ~/Library/Logs/termag-agent.log`                          |

After sleep/wake the WebSocket reconnects automatically (5s loop) and
the backend's session-reconstruction step recreates any missing tmux
sessions, running `claude --continue` to resume in-flight conversations.

### Verify

In the browser, create a project. The terminals should connect, and
`AGENTS.md` + `CLAUDE.md` should appear in the project working dir
(`~/termag/projects/<name>/`), which should also be a fresh git repo.
Status indicators should go live as soon as Claude starts running
(if they stay grey, step 6 didn't take — re-check `~/.claude/settings.json`).

The per-user agent must be restarted whenever `agent/agent.js` changes:
`systemctl --user restart termag-agent` (Linux) or
`launchctl kickstart -k gui/$(id -u)/io.termag.agent` (macOS).

## 5. Agent providers

`termag` supports multiple agent runtimes per project.

- `Codex` projects use the per-user agent to launch a managed Codex bridge plus
  `codex --remote` in the `*-agent` tmux pane
- `Claude` projects use the existing `claude` startup path

The selected provider is persisted on each `agent` workflow, and each user also
has a saved default provider used by the create-project form.

## 6. Claude Code hooks

Required for status indicators to work with the Claude provider —
the agent runs Claude inside tmux, but Claude itself reports
working/idle/needs-input state via Claude Code hooks. Without this
step, status dots stay grey.

**AMI-provisioned boxes already have this** — `packer/scripts/setup.sh`
bakes `deploy/claude-settings.json` into `~/.claude/settings.json`, so the
steps below are only needed for non-baked installs (e.g. macOS).

Add termag as a status hook target in `~/.claude/settings.json` so
each hook event POSTs to `http://localhost:3040/termag/api/status`.
See `deploy/claude-hooks.md` for the full configuration.

## 7. Slack bot

The Slack bot runs in the same process as the main server. Set these env vars in `.env`:
- `SLACK_BOT_TOKEN` (xoxb-)
- `SLACK_APP_TOKEN` (xapp-)
- `SLACK_SIGNING_SECRET`
- `CAPTURE_API_SECRET` (for LTS relay)

### Slack app setup

1. Create a Slack app at https://api.slack.com/apps
2. Enable Socket Mode
3. Add Bot Token Scopes: `app_mentions:read`, `chat:write`, `channels:manage`, `channels:read`, `commands`, `im:history`, `im:read`, `im:write`, `files:read`, `reactions:read`, `reactions:write`, `users:read`, `users:read.email`
4. Subscribe to bot events: `app_home_opened`, `app_mention`, `message.im`, `reaction_added`
5. Add slash command: `/t`
6. Install to workspace

### Slack commands

- `/t` — capture and post the active agent's terminal pane
- `/t <command>` — send a command to the agent terminal, then poll for output
- `/t !<keys>` — send keystrokes without Enter (e.g. `/t !2` for numbered prompts)
- `/t create <name>` — create a new project with agent workflow, tmux sessions, and Slack channel
- `/t switch <project>` — switch active project
- `/t attach <session>` — attach to a specific tmux session
- `/t ctrl` — capture the ctrl terminal pane
- `/t ctrl <command>` — send a command to the ctrl terminal
- `/t projects` — list projects
- `/t ls` — list tmux sessions

### Slack channel routing

Projects automatically get a `#proj-<name>` Slack channel on creation. When you
run `/t` commands inside a project channel, termag routes to that project
automatically — no `/t switch` needed. The `switch` and `attach` commands remain
for use in DMs or non-project channels.

### Emoji reactions

When a pane screenshot is posted, termag detects numbered prompts and adds
emoji hints (:one: :two: etc.). Reacting with one of these emojis sends that
keystroke to the terminal. This chains — the response pane will also get hints
if it contains new prompts.

Additional reactions:
- :white_check_mark: — sends `y` + Enter
- :x: — sends `n` + Enter
- :leftwards_arrow_with_hook: — sends Enter
- :arrows_counterclockwise: — refreshes the pane (no keystroke)

## 8. Discord bot

The Discord bot runs in the same process as the main server. Set these env vars in `.env`:
- `DISCORD_TOKEN` — Bot token from Discord Developer Portal
- `DISCORD_APP_ID` — Application ID
- `DISCORD_USER_MAP` — Maps Discord user IDs to unix usernames: `discordId:unixUser,discordId2:unixUser2`

### Discord app setup

1. Create an application at https://discord.com/developers/applications
2. Go to Bot → enable **Message Content Intent** under Privileged Gateway Intents
3. Copy the bot token into `DISCORD_TOKEN`
4. Copy the Application ID into `DISCORD_APP_ID`
5. Generate an invite URL: OAuth2 → URL Generator → scopes: `bot`, `applications.commands` → permissions: `Send Messages`, `Add Reactions`, `Read Message History`
6. Invite the bot to your server

### Discord commands

The `/t` slash command mirrors all Slack subcommands:

- `/t` — capture and post the active agent's terminal pane
- `/t <command>` — send a command to the agent terminal, then poll for output
- `/t !<keys>` — send keystrokes without Enter
- `/t create <name>` — create a new project with agent workflow and tmux sessions
- `/t switch <project>` — switch active project
- `/t attach <session>` — attach to a specific tmux session
- `/t ctrl` — capture the ctrl terminal pane
- `/t ctrl <command>` — send a command to the ctrl terminal
- `/t projects` — list projects
- `/t ls` — list tmux sessions

### Discord emoji reactions

Works the same as Slack — numbered prompts get reaction hints, and reacting sends keystrokes.

### Cross-platform notifications

When a session has notification targets registered for both Slack and Discord,
both platforms receive notifications when the agent needs input or finishes a task.
Use `/t switch <project>` on each platform to register notification targets.

## 9. Google OAuth

1. Go to https://console.cloud.google.com/
2. Create or reuse OAuth 2.0 credentials (Web application)
3. Add authorized redirect URI: `https://your-domain/termag/auth/google/callback`
4. Copy Client ID and Secret into backend `.env`

## 10. Adding users

Add to `ALLOWED_USERS` in `.env`: `email@gmail.com:unixuser`
Create their project directory: `mkdir -p /home/<unixuser>/termag/projects`
Restart: `sudo systemctl restart termag`

## 11. Chrome relay (optional, runs on your laptop)

```bash
cd relay
npm install
cp relay.config.example.json relay.config.json
# set termag_url and relay_token
node relay.js
```

Chrome must be launched with `--remote-debugging-port=9222`.

## Updating

```bash
cd frontend && npm run build
cd ../backend && npm run build
npx prisma generate
sudo systemctl restart termag
# Also restart the per-user agent if agent.js changed:
systemctl --user restart termag-agent
```

Frontend-only changes (CSS, React components) take effect with a hard refresh
without restarting the service, since the backend serves static files from
`frontend/dist/`.
