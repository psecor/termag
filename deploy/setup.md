# termag setup

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

## 4. Systemd

```bash
sudo cp deploy/termag.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now termag
```

## 5. Claude Code hooks

Add termag as a status hook target in `~/.claude/settings.json`.
Each hook event should POST to `http://localhost:3040/termag/api/status` with
`{ "session": "<tmux-session-name>", "status": "working|idle|waiting" }`.
See `deploy/claude-hooks.md` for the full configuration.

## 6. Slack bot

The Slack bot runs in the same process. Set these env vars in `.env`:
- `SLACK_BOT_TOKEN` (xoxb-)
- `SLACK_APP_TOKEN` (xapp-)
- `SLACK_SIGNING_SECRET`
- `CAPTURE_API_SECRET` (for LTS relay)

The old `claude-code-proxy-bot` service should be stopped/disabled.
LTS relay endpoints are now at `localhost:3040/lts/` (was port 3100).

## 7. Google OAuth

1. Go to https://console.cloud.google.com/
2. Create or reuse OAuth 2.0 credentials (Web application)
3. Add authorized redirect URI: `https://secorp.net/termag/auth/google/callback`
4. Copy Client ID and Secret into backend `.env`

## 8. Adding users

Add to `ALLOWED_USERS` in `.env`: `email@gmail.com:unixuser`
Create their project directory: `mkdir -p /home/<unixuser>/termag/projects`
Restart: `sudo systemctl restart termag`

## 9. Chrome relay (optional, runs on your laptop)

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
```

Frontend-only changes (CSS, React components) can be tested with a hard refresh
without restarting the service, since the backend serves static files.
