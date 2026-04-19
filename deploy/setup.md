# termag setup

## Prerequisites

- Node.js 18+
- PostgreSQL
- Apache with mod_proxy (or another reverse proxy)
- tmux
- Google OAuth credentials (for web login)
- Slack app (optional, for /t commands and notifications)
- Discord bot (optional, mirrors Slack /t commands)

## 1. Database

```bash
createdb -U secorp termag
cd backend
cp .env.example .env
# fill in .env (see .env.example for all variables)
npm install
npm run db:migrate:dev
```

Create the session table for connect-pg-simple:
```sql
psql -U secorp -d termag -c "
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

The agent handles tmux, PTY, and filesystem operations on behalf of each user.
Set up as a systemd user service:

```bash
# As the target user:
mkdir -p ~/.config/systemd/user
cp deploy/termag-agent.service ~/.config/systemd/user/
# Edit the service file to set correct paths and config
systemctl --user daemon-reload
systemctl --user enable --now termag-agent

# Enable lingering so the agent runs without an active login session
sudo loginctl enable-linger <username>
```

The agent connects to the main server via WebSocket using a bearer token.
Create a token in the termag UI (sidebar > Agent Tokens).

Agent config (`agent.config.json`):
```json
{
  "server_url": "ws://localhost:3040/termag/ws/agent",
  "token": "tmag_..."
}
```

## 5. Claude Code hooks

Add termag as a status hook target in `~/.claude/settings.json`.
Each hook event should POST to `http://localhost:3040/termag/api/status`.
See `deploy/claude-hooks.md` for the full configuration.

## 6. Slack bot

The Slack bot runs in the same process as the main server. Set these env vars in `.env`:
- `SLACK_BOT_TOKEN` (xoxb-)
- `SLACK_APP_TOKEN` (xapp-)
- `SLACK_SIGNING_SECRET`
- `CAPTURE_API_SECRET` (for LTS relay)

### Slack app setup

1. Create a Slack app at https://api.slack.com/apps
2. Enable Socket Mode
3. Add Bot Token Scopes: `chat:write`, `commands`, `reactions:read`, `reactions:write`, `users:read`, `users:read.email`
4. Subscribe to bot events: `app_home_opened`, `message.im`, `reaction_added`
5. Add slash command: `/t`
6. Install to workspace

### Slack commands

- `/t` — capture and post the active agent's terminal pane
- `/t <command>` — send a command to the agent terminal, then poll for output
- `/t !<keys>` — send keystrokes without Enter (e.g. `/t !2` for numbered prompts)
- `/t switch <project>` — switch active project
- `/t attach <session>` — attach to a specific tmux session
- `/t ctrl` — capture the ctrl terminal pane
- `/t ctrl <command>` — send a command to the ctrl terminal

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

## 7. Discord bot

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

## 8. Google OAuth

1. Go to https://console.cloud.google.com/
2. Create or reuse OAuth 2.0 credentials (Web application)
3. Add authorized redirect URI: `https://your-domain/termag/auth/google/callback`
4. Copy Client ID and Secret into backend `.env`

## 9. Adding users

Add to `ALLOWED_USERS` in `.env`: `email@gmail.com:unixuser`
Create their project directory: `mkdir -p /home/<unixuser>/termag/projects`
Restart: `sudo systemctl restart termag`

## 10. Chrome relay (optional, runs on your laptop)

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
sudo systemctl restart termag
# Also restart agent if agent.js changed:
systemctl --user restart termag-agent
```

Frontend-only changes (CSS, React components) take effect with a hard refresh
without restarting the service, since the backend serves static files from
`frontend/dist/`.
