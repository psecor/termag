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

> On an orchestrator with `HOST_AUTOSETUP=true` (the Termag-account deployment)
> none of this is manual: the backend creates each user's unix account and
> host agent the first time they need the orchestrator
> (`backend/src/services/hostSetup.ts`, `deploy/termag-host-setup`). The steps
> below are for hosts without it.

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

    <!-- Raise the file-descriptor ceiling above launchd's default 256.
         node-pty allocates 2-3 fds per terminal stream (master PTY + kqueue
         watcher), and short-lived dead fds can stack up briefly on WS
         reconnect cycles. 4096 leaves a generous safety margin. -->
    <key>SoftResourceLimits</key>
    <dict>
        <key>NumberOfFiles</key>
        <integer>4096</integer>
    </dict>

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
- `pi` projects run the pi coding agent with whatever model provider the box
  owner has configured for it; status comes from a pi extension rather than
  hooks

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

### Turning the whole app off

The flag `slack-interactions-enabled` turns termag off in Slack
without uninstalling the app (`backend/src/services/slackInteractionsFlag.ts`).
It is read for a multi-context, so a rule can target any of these:

- `service`: the orchestrator (key `termag-orchestrator`, with `environment` and `version`);
- `slack-workspace`: the Slack workspace (key: its team id, `T…`; with `name` and `enterpriseId`);
- `slack-org`: the workspace's Enterprise Grid org (key `E…`), only on Enterprise Grid.

For an incoming event, the workspace and org are the event's own. For the app's
client (notices, cards and other posts outside an event), they are the bot's,
from `auth.test`, asked once per process. So Slack can be on in one workspace or
org and off in the others. While the workspace is unknown (the bot's `auth.test`
failed, retried after 30 seconds, or an event names no workspace), Slack is off,
so an unknown workspace can't slip past a rule that turns its workspace off. Off:

- every event, button, shortcut, view and option request is acknowledged and
  dropped before any listener runs; a slash command gets "termag isn't available
  in Slack yet.", seen only by the person who ran it;
- the app's Web API client refuses every call except `auth.test`, so no DM,
  notice, collaboration card, briefing, automation report, home tab or space
  channel post goes out. A refused call throws like a Slack refusal, with
  `data.error` `termag_slack_interactions_off`.

The Slack MCP connector keeps working: its sign-in uses
the termag Slack app as its OAuth client and pins the workspace with the bot's
`auth.test`, and its calls go to `mcp.slack.com` with each person's own user token.

It is read on every event and every call, so switching it back on needs no
restart. It falls back on, so a deployment without a flag source keeps its bot.
While a flag source is configured but has not delivered its flags yet (a slow
start, or the flag source down at boot), Slack stays off.

### Who can use the bot

`/t` answers people the feature flag `slack-bot-enabled` is on for, on the
projects their termag user owns or was shared, as on the web. The flag is read
for the termag user whose email matches the Slack account's email
(`users:read.email`, in any casing), so a person needs a termag account and the
same email in both. Someone else's project channel, `/t switch` to their
project and `/t attach` to their session are refused, and `/t local` is not
available (`slackProjectAccess` in `backend/src/slack/access.ts`). Anyone else
who runs `/t`, DMs the bot or @mentions it gets a reply only they see, sending
them to #termag-help for access (`SLACK_ACCESS_CHANNEL` in `access.ts`), and
is told when no termag account has their Slack email (or to try again when
Slack's own lookup failed, which says nothing either way). A DM or @mention gets it
at most once per rate-limit window. The flag falls back off. A Slack account
that matched nobody is looked up again after five minutes.

DMs and @mentions are not part of the flag. They run `claude` with
`bypassPermissions` as the backend's own user, with its environment,
so they answer only `ALLOWED_SLACK_USERS`. Someone the flag lets in who DMs
or @mentions the bot is pointed at `/t` instead, in a reply only they see.

`ALLOWED_SLACK_USERS` is the operators' list: a comma-separated list of Slack
user IDs (`U01ABCDEF:youruser`; the unix half is ignored) that get in whatever
the flag says, with or without a termag account. They keep the routing the bot
always had (any project, by channel, name or session, and the local sessions)
and are the only ones DMs and @mentions answer. Keep it short. A deployment
without the flag uses it alone. The backend logs both sources when the bot
starts (`[SLACK] Who may use the bot: …`).

### Slack app setup

1. Create a Slack app at https://api.slack.com/apps
2. Enable Socket Mode
3. Add Bot Token Scopes: `app_mentions:read`, `chat:write`, `chat:write.public`, `channels:manage`, `channels:read`, `channels:history`, `channels:join`, `commands`, `im:history`, `im:read`, `im:write`, `files:read`, `files:write`, `reactions:read`, `reactions:write`, `users:read`, `users:read.email`, `assistant:write`, and for spaces in Slack `groups:read`, `groups:history`, `groups:write`
4. Subscribe to bot events: `app_home_opened`, `app_mention`, `message.channels`, `message.im`, `reaction_added`, `agent_session_stopped`, `app_context_changed`, and for spaces in Slack `message.groups`, `member_joined_channel`, `member_left_channel`, `channel_left`, `group_left`, `channel_archive`, `group_archive`, `channel_unarchive`, `group_unarchive`, `channel_rename`, `group_rename`, `channel_shared`
5. Add slash commands: `/t`, and `/termag` (an alias of `/t`, the same handler)
6. Add message shortcuts with callback ids `link_to_space` and `save_to_space`
7. Install to workspace, and reinstall after every scope or event change

The `groups:*` scopes, the channel events and `/termag` are for linking Slack
channels to a space, behind the
`space-channels-enabled` flag. Without the flag nothing reads them, but keep
them: a reinstall without them drops private space channels and the link
upkeep (gotcha `slack-scopes`).

Or create it from `deploy/slack-app-manifest.yaml`, which also makes the app the OAuth
client for Slack's MCP server through the MCP broker (its user scopes and the broker's
redirect URL). Its header comment lists the admin steps: set the redirect URL's host,
apply the manifest, reinstall, and put the app's Client ID and Client Secret in
`MCP_OAUTH_CLIENTS` and the variable it names.

A second app for local development needs its own commands (`SLACK_COMMAND=/tdev`
and `SLACK_COMMAND_ALIAS=/termagdev`, and the same in its manifest) and its own tokens.

### Agent experience (optional)

DMs and @mentions run Claude Code in your active project (`/t switch`), and
only for the operators in `ALLOWED_SLACK_USERS` (above); none of what
follows widens that. Declaring
the app an agent (app settings → **Agents** → **Agent experience**, which adds
the `assistant:write` scope) makes each DM thread a Slack agent session: Slack
shows **Working…** and a Stop button, the reply streams in, the thread gets its
first line as its title, and each thread keeps its own Claude session (resumed
while the active project stays the same). Also subscribe to the
`agent_session_stopped` bot event, or Stop has nothing to deliver it, and
reinstall. `deploy/slack-app-manifest.yaml` already has `assistant:write`,
`files:write` and `agent_session_stopped` (spaces in Slack need them); the
agent view itself is still added by hand. In a hand-written manifest:

```yaml
features:
  agent_view:
    agent_description: Runs Claude Code in your active termag project.
    suggested_prompts:
      - title: Tour this repo
        message: Give me a short tour of this repository.
oauth_config:
  scopes:
    bot: [assistant:write, files:write]   # added to the existing list; files:write only for attachments
settings:
  event_subscriptions:
    bot_events: [agent_session_stopped]   # added to the existing list
```

Claude can end a question with `[choices: A | B]`, which the bot shows as
buttons; a click (only by the person the reply was for) becomes their next
message. It can also offer files with `[attach: <path>]`, which needs the
`files:write` scope. Nothing is uploaded from Claude's reply alone: each file
becomes a Share / Don't share question showing its name, size and path, which
only the person the reply was for can answer, and it is checked again before
upload. Only images, PDF, CSV, text, Markdown and diffs (not JSON, logs or
HTML) under the working directory or the turn's own temp directory qualify,
never dotfiles (`slack/agentAttachments.ts`). Each turn gets a fresh
`$TMPDIR/termag-slack-run-*` directory (Claude's `TMPDIR`), removed after a
day; the shared `/tmp` is not a root, since every operator's turn runs as the
same unix user.

With **Suggested Prompts → Dynamic**, the bot sets the Messages tab's prompts
for the user's active project each time they open it; **Fixed** uses the
manifest's `suggested_prompts` instead.

The backend takes the agent path when the bot token has `assistant:write`
(checked every five minutes, `slack/agentSession.ts`) **and** the
flag `slack-agent-enabled` is on for the person writing (their termag account,
matched by email), who must already be one DMs and @mentions answer; otherwise
it answers them as before. Locally,
`TERMAG_FLAGS='{"slack-agent-enabled":true}'` turns it on. An @mention in a channel becomes
an agent session in its thread too, with three differences: the thread belongs
to whoever first @mentioned the bot there (anyone else is told privately to
start their own thread), follow-ups still need an @mention, and the thread only
ever resumes its own Claude session (a DM's recent conversation never carries
into a channel). A group DM counts as a channel here. Stop ends a run only for
the person it is running for, and one person may have three agent
conversations running at once, with at most six running for everyone together
(`SLACK_AGENT_MAX_RUNS`). A turn's machinery is in `slack/session/`: `runTurn` around a
driver (the operator's runs `claude` here, `operatorDriver.ts`), the caps by
thread scope (`caps.ts`), and the stream budget (`slack/streamBudget.ts`, 18
`chat.startStream` a minute, `SLACK_STREAM_STARTS_PER_MINUTE`). An operator's
reply always streams and only counts against that budget. Thread owners and sessions are saved
(`slack_agent_threads`, `slack_agent_dm_last`) and read back when the bot
connects, so a deploy keeps them; runs live in the backend's memory, which
assumes one process holds the Slack connection (with `ORCHESTRATOR_LEASE`, only
the lease holder does). A shutdown, or a lease handover that moves the Slack
connection elsewhere, stops this process's running turns with a "termag is
restarting, send it again" note first, so the next holder never runs a second
`claude` on the same session. A thread claimed before its saved owner was
loaded starts a fresh conversation rather than inheriting one. A reply that cannot pick up its thread's
earlier conversation (the active project changed, Claude no longer has the
session, or the thread is older than 14 days) says so and starts fresh.
Some agent features need a paid Slack plan or a Developer Program sandbox.

### Slack commands

- `/t` — capture and post the active agent's terminal pane
- `/t <command>` — send a command to the agent terminal, then poll for output
- `/t !<keys>` — send keystrokes without Enter (e.g. `/t !2` for numbered prompts)
- `/t -- <text>` — send the text exactly as written, with Enter, even when it
  starts with a command word or `!` (an em dash works too, for iOS)
- `/t help [<command>]` — the commands, or one in detail (`/t help routing`
  explains which project `/t` drives); only the caller sees it
- `/t create <name>` — create a new project with agent workflow, tmux sessions, and Slack channel
- `/t switch <project>[/<workstream>]` — switch active project (and workstream)
- `/t attach <session>` — attach to a specific tmux session
- `/t ctrl` — capture the ctrl terminal pane
- `/t ctrl <command>` — send a command to the ctrl terminal
- `/t projects` — list your own and shared projects
- `/t ls` — list the tmux sessions on each of your boxes that is up (and on a
  per-user agent)

A command word counts only in the form above (`backend/src/slack/slashCommand.ts`),
in any casing (phones capitalise `/t Projects`). Any other text is sent to the
agent: `/t projects` lists projects, and `/t projects ls` sends `projects ls`.
A command word without the argument it needs (`/t switch`) shows that
command's help, and one whose argument matched nothing (`/t switch branches`)
says how to send the text instead (`/t -- switch branches`).

Errors, refusals and help are replies only the caller sees; panes, listings
and what a command did are posted to the channel. When the bot cannot post in
a conversation (a private channel or group DM it isn't in), `/t` says so to
the caller instead of failing silently.

### Slack channel routing

Projects automatically get a `#proj-<user>-<project>` Slack channel on creation,
and every additional workstream (git worktree) gets `#proj-<user>-<project>-<workstream>`.
The names mirror the tmux session names minus the role, and include the unix
username because project names are only unique per user. When you run `/t`
commands inside one of these channels, termag routes to that workstream's tmux
pair automatically — no `/t switch` needed.

Channels created by hand work too: termag matches the channel name against the
canonical names of every live project/workstream (no dash parsing), then falls
back to the legacy `#proj-<project>` form, preferring your own project. A match
is saved on the row so later lookups are direct. Deleting a workstream archives
its channel.

In DMs or non-project channels use `/t switch <project>[/<workstream>]` to pick
a target, or `/t attach <tmux-session>` to capture a specific session. The choice
is saved (`chat_active_targets`), so it survives restarts and deploys.

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

The `/t` slash command mirrors all Slack subcommands. It reaches only the
projects the linked termag user owns or was shared: `/t attach` treats someone
else's session as missing, and a saved target that isn't theirs is refused.

- `/t` — capture and post the active agent's terminal pane
- `/t <command>` — send a command to the agent terminal, then poll for output
- `/t !<keys>` — send keystrokes without Enter
- `/t create <name>` — create a new project with agent workflow and tmux sessions
- `/t switch <project>[/<workstream>]` — switch active project (and workstream)
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

Add to `ALLOWED_USERS` in `.env`: `email@example.com:unixuser`
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
