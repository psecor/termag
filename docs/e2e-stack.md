# Local end-to-end stack

One command starts a whole termag on one machine: an orchestrator and N stand-in
boxes, reachable in a browser. It is meant for agents (and people) who want to
exercise the real UI and the real box protocol before opening a PR.

```bash
make e2e-up            # two boxes; BOXES=3 make e2e-up for more
make e2e-status        # what is running, and where
make e2e-down          # stop everything and delete the temp root
make e2e-test          # scripted check of the whole flow, and of every fake, on spare ports
make e2e-up E2E_FAKE_AWS=1 E2E_FAKE_CLAUDE=1   # with opt-in fakes (see below)
make e2e-up E2E_FAKE_AWS=1 E2E_EC2_LAUNCH=1 E2E_FAKE_GITHUB=1 E2E_WARM_POOL=2   # the warm pool, claimable from Add box
```

## What you get

| Piece | Where | Notes |
|-------|-------|-------|
| UI | `http://localhost:5174/termag/` | Vite dev server (hot reload), proxying to the backend. Click **Sign in**. |
| Backend | `http://127.0.0.1:3040/termag` | `tsx src/index.ts`, bound to loopback, `AUTH_MODE=local`, `LOCAL_SESSIONS_ENABLED=false`. Restart the stack to pick up backend changes. |
| Postgres | `127.0.0.1:55432`, db `termag`, user `termag` | A private cluster (`initdb`) in the temp root, schema synced by the production `db:push` step (`src/scripts/dbPush.ts`). |
| Boxes | `box-1` … `box-N` | Each is `agent/agent.js` with its own temp `HOME` and its own tmux server, registered as an `external` box through `POST /api/instances`. |
| Box network | `127.0.0.1:3041` (`E2E_PORT`+1) | `scripts/e2e/box-network.mjs`, a TCP relay every box's agent URL points at. It dials the backend (or nginx's TLS listener with `E2E_TLS`) from `127.0.0.2`, so the backend sees the boxes as another host, as it sees real boxes. Their status writes are then authenticated by the box token and filed under that box, as in production. From `127.0.0.1` they would be trusted as the orchestrator's own and filed under no box, which leaves box status pills empty. |
| Seed | user `e2e@termag.local`, boxes `ready`, project `sample` on `box-1` | Created through the HTTP API, not SQL. |

Ports move with `E2E_PORT` (the box network takes the next port), `E2E_FRONTEND_PORT` and `E2E_PG_PORT`; the sign-in
email with `E2E_EMAIL`. Everything lives under one `mktemp -d` root (printed by
`make e2e-up` and `make e2e-status`): `logs/` has one log per process,
`boxes/<name>/home` is that box's home, and `backend.env` is the backend's whole
configuration. Processes start from an empty environment, so AWS, Slack or box
provisioning settings in your shell or `backend/.env` never reach the stack.

## Driving a box from the shell

Each box has `boxes/<name>/bin/tmux`, a wrapper around that box's private tmux
socket, `boxes/<name>/tmux/sock`. Use it, never a plain `tmux` (see
[Isolation](#isolation)). Pane shells have it on `PATH`, prompt with the box name, and carry
`deploy/termag-status`, the script the Claude Code hooks call:

```bash
root=$(cat "${TMPDIR:-/tmp}/termag-e2e-$(id -un).root")
"$root/boxes/box-1/bin/tmux" ls
"$root/boxes/box-1/bin/tmux" send-keys -t "$(id -un)-sample-agent" 'termag-status working' Enter
```

That turns the project's status pill green, through the same authenticated
status write a real box makes. `waiting` needs a Claude Code notification
payload (`termag-status notification` on stdin); `idle` and `not_running` work
like `working`. No agent CLIs are installed, so the agent pane shows
`claude: command not found` unless you start the stack with `E2E_FAKE_CLAUDE=1`.

`scripts/e2e/ctl.sh` (or `make e2e-ctl ARGS=...`) stops, starts or restarts one
process with the command `up.sh` used, so it re-reads an edited `backend.env`
or agent config: `ctl.sh restart backend`, `ctl.sh stop box-2`. Stopping a box
leaves its tmux server running, as a real agent restart does.
`make e2e-status` shows each box agent's open fds, `/dev/ptmx` fds, tmux
clients and children; `watch -n1 make e2e-status` is a live view.

`make e2e-up` copies the fakes (`scripts/e2e/fakes/claude-stream.mjs` and the
rest) into each box's `boxes/<name>/bin/`, and a running box keeps that copy:
an edit to a fake in the repo changes nothing until you copy it over
(`cp scripts/e2e/fakes/<file> "$root"/boxes/*/bin/`) or bring the stack down
and up. Frontend edits are live (Vite HMR); `agent/` edits need `ctl.sh
restart box-N`, as a real box's agent does.

To run two stacks side by side (say `main` and your branch), give each its own
`TMPDIR` and ports. Both UIs are on `localhost` and share the session cookie,
so use separate browser profiles. The pointer to the running stack,
`${TMPDIR:-/tmp}/termag-e2e-$(id -un).root`, is per unix user, so two sessions
on one machine as the same user (several asks on one box) that share a
`TMPDIR` overwrite each other's pointer, and `make e2e-down` tears down the
other's stack. Pass the same `TMPDIR=<yours>` to `make e2e-up`, `make
e2e-down` and every `scripts/e2e/ctl.sh` call, and check `ss -ltn` for
3040/3041/5174/55432 before choosing `E2E_PORT`, `E2E_FRONTEND_PORT` and
`E2E_PG_PORT`.

With no PostgreSQL server installed and no sudo, take the binaries from a
container: `apt-get install postgresql-16` in `ubuntu:24.04`, copy its
`/usr/lib/postgresql` and `/usr/share/postgresql/16` out to a directory under
the same relative layout (`<dir>/usr/lib/postgresql/…`), and pass
`E2E_PG_BIN=<dir>/usr/lib/postgresql/16/bin`. They run as they are on an
Ubuntu 24.04 host.

For something that outlives a session, with your real tmux sessions and the
real agent CLIs instead of stand-in boxes, see [stage.md](stage.md).

## Isolation

Stand-in boxes run as you, on your machine, so a box's tmux server that got
*your* environment would hand every pane in it your HOME: your
`~/.claude/settings.json` hooks, your `~/.termag/agent.config.json` and its
token, your `~/.config/termag`, `gh` and git credentials, and any `TERMAG_*` or
`GH_TOKEN` your shell holds. The `termag-status` hook in such a pane posts to
your real orchestrator with your real box's token. That happened once: a
session started on a box before its tmux server was up, from a shell outside
the box's wrapper, started the server with the caller's environment. The stack
now fails closed:

- **One environment per box.** `boxes/<name>/bin/tmux` (`write_box_tmux` in
  `scripts/e2e/lib.sh`) runs every tmux call under `env -i` with the box agent's
  own environment, whoever calls it. It keeps only the caller's `TERM` and
  `COLORTERM`, and `TMUX`/`TMUX_PANE` when they name this box's socket.
  `new-session -e` still sets what the agent asks for.
- **No other way to start a server.** `box.sh` starts the box's server through
  the wrapper before the agent runs, with `exit-empty off`, so it stays up with
  no sessions. The socket's directory, `boxes/<name>/tmux/`, is read-only except
  while the wrapper starts the server, so a `tmux -S boxes/<name>/tmux/sock`
  from your shell can reach the running server (and its sessions get the box's
  environment) but cannot start one. **As root this layer does not hold**
  (root ignores directory modes): `make e2e-up` says so, and only the check
  and the hook's guard below stand between a stray server and your real
  orchestrator.
- **A PATH of its own.** A box's PATH is its `bin/` (the wrapper, the box's
  `termag-status`, the fakes, `E2E_CLAUDE_BIN`'s link), then `<root>/bin`,
  then `/usr/bin:/bin:/usr/sbin:/sbin`, never yours. `<root>/bin` links, by
  name and from your PATH, only the tools boxes call (`E2E_BOX_TOOLS` in
  `lib.sh`: node, git, jq, curl, tmux, gh, …). `~/.local/bin`, nvm's bin,
  `/usr/local/bin` and Homebrew, where your `claude`, `codex`, `termag` and
  `termag-status` live, don't reach a box, so an agent pane without
  `E2E_FAKE_CLAUDE` or `E2E_CLAUDE_BIN` shows `claude: command not found`.
  Panes are login shells, and the system profile (`/etc/profile` and its
  `profile.d`, macOS's `path_helper`, `/etc/zsh/zshenv`) puts those
  directories back, so the box's own `~/.bash_profile`, `~/.profile` and
  `~/.zprofile` (rewritten by `box.sh` on every start, never through a
  symlink) end by exporting the allow-list PATH again. A claimed box's
  dotfiles may link their own over them until the box next starts.
- **Checked.** `make e2e-up` fails, and `make e2e-status` prints `ISOLATION …`
  and exits 1, when any tmux server on any socket under the root has a HOME
  outside the root or lacks `TERMAG_E2E_ROOT` (globally or in a session).
  `make e2e-down` stops every tmux server on a socket under the root, including
  one with your environment, which the `TERMAG_E2E_ROOT` sweep cannot see.
- **The hook refuses.** `up.sh` writes `<root>/status-origins`, the stack's
  own origins (the box network, the backend, and with `E2E_TLS` its TLS front).
  `deploy/termag-status` treats a hook with `TERMAG_E2E_ROOT` set, or whose
  `$TMUX` socket is under a directory holding `.termag-e2e`, as a stand-in
  box's, and posts only to those origins. Anything else is refused on stderr and
  in `logs/status-refused.log`: `termag-status: refusing to post to <origin>:
  this hook runs on a stand-in box of the e2e stack at <root>, …`. The real
  hook on your machine is the `termag-status` your box was installed with, so
  this holds only once that box has a `deploy/termag-status` with the guard.

The deliberate exceptions are unchanged: `E2E_REAL_GITHUB` asks your git for a
credential through `real-github/git-credential`, `E2E_CLAUDE_BIN` links your
Claude Code (and on macOS your keychains), and ssh from a box uses your
passwd entry's `~/.ssh`. `scripts/e2e/isolation.test.sh` (in `make e2e-test`,
alone `make e2e-test-isolation`) replays the incident: it runs as a stand-in
"you" whose orchestrator is a local listener, starts box sessions the wrong
ways (through `bin/tmux` with the server down, with `tmux -S` and the server
down or up, and a stray server under the root), runs the status hook in each,
and fails on any request the listener gets.

What the stack can't guard is your own shell:

- **Start sessions only through the stack's helpers**, and check `bin/tmux ls`
  and the pane's `$HOME` before typing into one. When you change what a pane's
  environment is, test it in a login-shell pane (a session with no command, or
  `bash -l` / `zsh -l`), not only in `new-session '<cmd>'`:
  `isolation.test.sh` has both kinds.
- **Call the stack's CLI by its full path.** A `termag` wrapper for the stack
  (its own `HOME` and `XDG_CONFIG_HOME`, `TERMAG_URL=http://127.0.0.1:3041/termag`)
  works only while it is first on `PATH`, and an agent's `PATH` export lasts
  one tool call. In the next call a plain `termag space rm …` is your real CLI
  against your real orchestrator, and deletes for real whatever has that name
  there. Run it as `<dir>/bin/termag` every time.
- **Never clean up after a test on the production orchestrator.** If something
  leaked there, report it instead.
- **Grow disk runs the host's real `sudo`.** A stand-in box's agent runs as you
  with `/usr/bin/sudo` on its PATH and advertises `disk-grow-v1` on Linux, so
  the admin page's Grow disk would run `sudo -n growpart` and `resize2fs`
  (`agent/disk-grow.js`) on this machine's root disk. Before trying it, put
  stand-in `sudo`, `df` and `findmnt` in `boxes/<name>/bin`, which comes first
  on the box's PATH. Floci answers `ModifyVolume` and
  `DescribeVolumesModifications` with "not supported" anyway (below), so the
  disk row reads "could not read the volume" until the launch fake answers them.

## Opt-in fakes

Each fake is off unless its variable is set, and lives under the stack's temp
root like everything else. `make e2e-test` checks all of them
(`scripts/e2e/fakes.test.sh`).

| Variable | What it stands in for | How it is wired |
|----------|----------------------|-----------------|
| `E2E_FAKE_AWS=1` | S3, SSM Parameter Store, KMS, Secrets Manager, STS, IAM, EC2 API | [Floci](https://github.com/floci-io/floci) 2.1.0 (MIT) on `127.0.0.1:4566` (`E2E_AWS_PORT`; `4586` on macOS, where 4566 is often another emulator's), natively on Linux and in Docker on macOS (`E2E_FLOCI`, next row). The backend gets `AWS_REGION` (`E2E_AWS_REGION`, default `us-east-2`), dummy keys and `AWS_ENDPOINT_URL`, which every AWS SDK v3 client honors, so no code needs an endpoint override. |
| `E2E_FLOCI=native\|docker` | How Floci runs | `native`: the pinned Linux binary (below), no Docker. `docker`: the `floci/floci:2.1.0-compat` image (`E2E_FLOCI_IMAGE`) as one container per stack, `termag-e2e-floci-<root suffix>`, labelled `termag.e2e.root=<root>`, run as your uid with `FLOCI_SERVICES_EC2_MOCK=true`, published on `127.0.0.1:$E2E_AWS_PORT` only, with its data dir bind-mounted from `<root>/floci/data`. The Docker socket is never mounted into it, so Floci's Docker-backed services (Lambda, RDS, ElastiCache) cannot start anything. The name goes in `<root>/floci/container`, and `make e2e-down` removes that one container, by its exact name and only when its label names the root (`fakes/floci.sh docker-rm`); `ctl.sh restart floci` works as for any process. Unset: `native` where there is a build (Linux x86_64 and aarch64), else `docker` when a Docker daemon answers (macOS), else up.sh stops and says to start Docker. The docker CLI talks to the daemon your shell's `docker` uses (`DOCKER_HOST`, else the current context's endpoint). |
| `E2E_AWS_SEED=<file>` | What terraform would have created | A bash script run once Floci is up, with `E2E_AWS_URL` set and `aws.sh` on `PATH` (below). |
| `E2E_CREDENTIAL_STORE=1` | The per-user credential store's KMS key | Needs `E2E_FAKE_AWS=1`. `fakes/credential-store.sh seed-aws` creates the key behind `alias/termag-user-credentials` (or reuses the one an `E2E_AWS_SEED` made) and gives the backend its ARN as `CREDENTIAL_STORE_KMS_KEY_ID`, as terraform does; the backend needs the ARN because Encryption SDK decryption matches it, never an alias. Floci's KMS returns the key ARN and refuses a `Decrypt` whose encryption context differs, but applies no key policy or IAM condition. |
| `E2E_SPACES=1` | The spaces bucket and KMS key | Needs `E2E_FAKE_AWS=1`. `fakes/spaces.sh seed` creates `termag-spaces-<account>-<region>-an` (Floci's account is `000000000000`), versioned and with the browser CORS rule for the frontend's origins, and `alias/termag-spaces`: the names the backend derives, so the backend gets no env of its own. Floci does not check presigned signatures, so a PUT whose length or headers differ from what was signed still succeeds here; `spaceObjects.test.ts` pins what is signed. `scripts/e2e/spaces.test.sh` drives it. |
| `E2E_FAKE_CLAUDE=1` | The Claude Code CLI | `scripts/e2e/fakes/claude` on each box's `PATH`, and `fakes/claude-stream.mjs` behind the chat runner; what it does is listed under [The fake Claude](#the-fake-claude), one behaviour per bullet. |
| `E2E_T3=1` | The desktop app's box bridge | Every box's agent advertises `t3-v1` and runs a t3code server on loopback when asked (`agent/t3-bridge.js`). The boxes run upstream's t3 `0.1.1` release archive for this machine's platform, pinned by digest in `scripts/e2e/fakes/t3.sh`. It's downloaded once into `E2E_CACHE_DIR/t3-<version>-<sha256>` (about 90 MB), a mismatch fails, and the boxes get the extracted binary as `TERMAG_T3_COMMAND`; each box keeps its own state under its `~/.t3`. With `E2E_FAKE_CLAUDE` or `E2E_CLAUDE_BIN` the boxes also get `TERMAG_T3_CLAUDE_COMMAND=claude`, which pins t3's Claude provider to the box's own `bin/claude` (t3 otherwise finds claude through the login shell's PATH, which on a stand-in box is not the box's). `E2E_T3_COMMAND=<cmd>` runs another build instead (a fork's). `scripts/e2e/t3.test.sh` (`make e2e-test-t3`) drives the bridge end to end. |
| `E2E_CLAUDE_SIGNED_IN=1` | A box signed in through the termag gateway | With `E2E_FAKE_CLAUDE`: every stand-in box, a launched one too, gets a gateway `apiKeyHelper` in its `~/.claude/settings.json`, so `claude auth status` says signed in (`third_party`) as on a real box once credentials are delivered, and the chat shows no "Sign in to Claude Enterprise" card. Without it, stand-in boxes are never signed in and the card always shows, which is how its flow is demoed. |
| `E2E_CLAUDE_BIN=<path>` | A real Claude Code on the boxes | Links that binary as `claude` into every box's `bin/`, for trying a t3 thread on a box by hand with your own Claude login. On macOS that login is in the keychain, which Claude Code looks up under `$HOME`, so each box also links its `~/Library/Keychains` to yours (its config and sessions stay in the box's own `~/.claude`). On Linux the login is in `~/.claude/.credentials.json`, which a box's own `HOME` hides: sign in on the box (`claude auth login` in its ctrl pane). Not with `E2E_FAKE_CLAUDE`. |
| `E2E_FAKE_GITHUB=1` | `api.github.com`, and `gh` on boxes | `github-stub.mjs` on `127.0.0.1:4580` (`E2E_GITHUB_PORT`): `GET /user` (a token containing `_bad` gets 401, `_noscope` lacks `admin:public_key`, `_readonly` is a read-only fine-grained PAT, `e2e-pool-bot` with no scopes, whose fetches pass and whose pushes and REST writes get 403: the environment pool's credential, `PUT /api/admin/pool-credential/github`), `GET/POST /user/keys`, `DELETE /user/keys/:id`, `GET /meta` (no `installed_version`, as on api.github.com, and gzipped for a client that accepts it), `GET /`, `GET /repos/:owner/:repo`, `GET /search/issues` and `POST /graphql` (what `gh` calls through a broker, including `gh pr list`, its searches and `gh search prs`, which list the viewer's open PRs, and `gh`'s type introspection; it also answers the PR pipeline's searches and overview with one review request, example-org/termag#4242, which `POST /repos/example-org/termag/pulls/4242/reviews` clears, and two of the viewer's own PRs for the merge panel: #4243 clean for `PUT …/pulls/4243/merge`, #4244 blocked for the auto-merge mutations, #4245 with a failed Actions run 777 for `POST …/actions/runs/777/rerun-failed-jobs` and a failed Bugbot suite; #4244 also carries e2e-bob's change request and pending e2e-carol / team e2e-team for `POST …/pulls/4244/requested_reviewers` and `…/issues/4244/comments`; a merged #4243 answers `compare` as not in any running commit, and `…/actions/workflows/publish-ami.yml/runs` / `/dispatches` start and show one bake), and `GET /_e2e/calls` for the call log, where each call carries a token fingerprint (the first 8 hex of its sha256), never the token. It also serves github.com's git smart-HTTP under `/_github.com/` with `git http-backend`, from bare repositories under `<root>/github` (`e2e-org/sample` and `e2e-org/sample-api` are seeded with one commit each, as are the viewer's `e2e-octocat/shop-web`, `e2e-octocat/shop-api` and `e2e-octocat/shop-docs`, which `GET /user/repos` and the repository pickers list first, ahead of the made-up rows; pushes are accepted; a `termag-e2e-public` file in a bare repository makes its fetches anonymous, a `termag-e2e-slow` file holding N holds each fetch's pack back N seconds, so a clone can be seen running). `GET /repos/<o>/<r>` answers any repository: one it serves as it is, any other as private, on `main`. For a served one, `GET /repos/<o>/<r>/commits/HEAD` (or `commits/<branch>`, 422 for no such branch: an environment pointer's) answers its default branch's (or that branch's) head sha and `GET /repos/<o>/<r>/contents/<path>?ref=<sha>` a file at that commit, raw (a private one needs a token): what the backend reads a repository's `.termag/environment.json` with. The public `e2e-org/big-memory` asks for `{ "resources": { "vcpu": 4, "memoryGiB": 32 } }`, `e2e-org/many-cores` for `{ "vcpu": 8, "memoryGiB": 16 }` (the two together make a large box), `e2e-org/big-disk` for `{ "diskGiB": 250 }`, `e2e-org/typo-box` has a `resources` termag ignores with a warning, and `e2e-org/bare-box` says `{ "setupEnabled": false }` (with `empty-box-enabled`, what the CLI states and `--setup` overrides). The backend's global `fetch` to `https://api.github.com` and `https://github.com` is redirected to it by a `--require` preload (`github-redirect.cjs`); other HTTP clients are not. Boxes get a `gh` that stores a token from `gh auth login --with-token`; a call aimed at any other host (`--hostname`, `-h` or `GH_HOST`) runs the real `gh` if one is installed, so `gh` can be driven through an orchestrator-side broker while github.com stays stubbed. |
| `E2E_CHROMIUM=<binary>` | The owner's browser pane on a stand-in box | Each box's agent gets it as `TERMAG_CHROMIUM` (`agent/browser-pane.js`). The Chromium snap, which the pane picks first, starts only with the user's real HOME, and a stand-in box has its own, so without this the owner's pane times out ("Target.createTarget: timed out"). Playwright's build works: `E2E_CHROMIUM=$(ls -d /opt/ms-playwright/chromium-*/chrome-linux*/chrome \| head -1)`. It runs through `<root>/bin/e2e-chromium`, which adds `--no-sandbox`: Ubuntu 23.10+ gives a non-snap Chromium no sandbox (AppArmor's user-namespace rule), and it would abort. A reviewer's guest pane runs as `termag-guest`, in that user's real home, and is not affected. |
| `E2E_GITHUB_MIRROR="owner/name=<checkout> ..."` | A real repository a box clones, served by the stub | Needs `E2E_FAKE_GITHUB=1`. Each checkout is cloned bare into the stub at its current branch, public, under that name, so a project on it clones the repository as it is, `.termag/environment.json` and all. `E2E_GITHUB_MIRROR="e2e-org/termag=$PWD"` serves termag itself: a box made for it runs termag's own file, whose `run` is this stack, started inside the stand-in box. That inner stack takes the default ports, so start the outer one on others (`E2E_PORT=4040 E2E_FRONTEND_PORT=6174 E2E_PG_PORT=56432`); a box hands it the real tmux as `E2E_REAL_TMUX`, since the box's own `tmux` wrapper would start the inner stack's servers with the box's environment and fail its isolation check. |
| `E2E_REAL_GITHUB=1` | A box's GitHub access, with your own credentials | Needs `E2E_FAKE_GITHUB=1`, not with `E2E_CLAUDE_GATEWAY` or `E2E_TLS` (whose boxes trust only the stack's CA). Boxes clone and fetch from the real `github.com`: their git config has no rewrite to the stub, and their git's only credential helper is `<root>/real-github/git-credential` (`fakes/git-credential-host`), which asks *your* git (your HOME: the keychain, gh's credential helper) for a credential and hands it to the box's git for that request only. It is set for `https://github.com` in the box's environment (`GIT_CONFIG_COUNT`, which git reads after every config file) behind an empty `credential.helper`, which drops any helper a config file gave: git sends `store` to every helper it has, and a linked dotfiles `.gitconfig` (`helper = store`, osxkeychain) or Apple git's built-in osxkeychain would otherwise keep the token. No token is written in the stack; `store` and `erase` are ignored, so your keychain is never written; and it answers only the transport of a `git clone`, `fetch`, `pull` or `ls-remote`, never a push or a bare `git credential fill` (`fakes/git-credential-host.test.sh`, in `make e2e-test`, checks that without the network, with a dotfiles `.gitconfig` in the box's HOME). A box's pushes go to the stub (`pushInsteadOf` for `https://github.com/`, `git@github.com:` and `ssh://git@github.com/`; ssh would use your own keys, the passwd entry's `~/.ssh`), and its `gh` stays the stand-in. The orchestrator is unchanged: every GitHub call it makes goes to the stub, which answers a lookup of a repository it does not serve (`GET /repos/<o>/<r>`) as a private one on `main`. Stand-in boxes run as you, so this keeps git's own plumbing (a push, a bare `git credential fill`, another helper's `store`) from handing the token out, not code that sets out to read it: a helper the box puts on a command line (`git -c credential.helper=…`) sees what this one answers. |
| `E2E_DOTFILES_REPO=<url>` | Your dotfiles on claimed boxes | Needs `E2E_WARM_POOL`. `https://github.com/<owner>/<repo>` (a trailing `/` or `.git` is dropped, as Settings does), saved as the user's dotfiles repository by the seed (`PUT /auth/me/preferences`, what Settings → Dotfiles does). As in production it is applied when a box is claimed from the warm pool, through the on-claim unit and the real `deploy/termag-hook-run claim`: cloned to the box's `~/.dotfiles`, from the stub (with `E2E_FAKE_GITHUB` and without `E2E_REAL_GITHUB` up.sh mirrors the repository into the stub once, anonymously, so it must be public) or from GitHub. **Nothing from the repository runs**: every stand-in box has `TERMAG_DOTFILES_NO_SCRIPTS=1`, so the entrypoint (`install.sh`, …) or a chezmoi source is named in `~/.termag/on-claim.log` and skipped, and only the repository's top-level dotfiles are linked into the box's home. A stand-in box is not a sandbox: a dotfiles script would run as you, on your machine. `E2E_DOTFILES_SCRIPTS=1` runs entrypoints anyway, for a repository whose script you have read (the stub's `e2e-org/dotfiles`, say; `warm-pool.test.sh` sets it). |
| `E2E_ASK_RUNNER=1` | Asks on any box, a launched one too | Every box gets the real `deploy/termag-subagent-run` at `~/.local/bin` (as `termag-reconcile` installs it on a box image), so its agent announces `ask-v1` and `ask-chat-v1` from its first connect, and `termag ask --new-box` runs end to end. With `E2E_FAKE_CLAUDE` the turns run the stand-in claude. |
| `E2E_PANE_CLONE=1` | An agent without the durable clone | By default every box has the durable clone unit, `termag-project-clone@.service`, run by the `systemctl` stand-in (`fakes/systemctl`) from a `~/src/termag` whose `deploy/termag-project-clone` and `agent/` are the repo's, and `~/.config/termag/github.skip` (no broker will deliver GitHub; with `E2E_CLAUDE_GATEWAY` there is one, and the clone waits for it), so its agent advertises `project-clone-v1` and a project from a repository clones as on a box image: beside its directory, `pending` → `cloning` → `ready` or `failed`, its sessions started once it is in. `E2E_PANE_CLONE=1` leaves the unit out, so the checkout is typed into the agent pane ahead of the agent, as for an agent from before the unit, and the project is `none` at once. |
| `E2E_TLS=1` | The orchestrator's nginx, the ALB and the checks ALB | nginx runs the real `deploy/nginx/termag-gateway.conf` and `termag-proxy.conf` on `127.0.0.1:13040` (`E2E_GATEWAY_PORT`) and the real `deploy/nginx/termag-checks.conf` on `127.0.0.1:13041` (`E2E_CHECKS_PORT`), plus two TLS fronts with a per-stack CA (`<root>/tls/ca.pem`): `localhost:3443` (`E2E_TLS_PORT`) stands in for the ALB boxes dial `wss://` through, and `localhost:3645` (`E2E_CHECKS_ALB_PORT`) for the orchestrator checks' internal ALB, which forwards only `/termag/internal/*` to the checks listener and answers anything else with 404. The gateway's Envoy verifies it with the same CA. Boxes connect over `wss://` and trust the CA through `NODE_EXTRA_CA_CERTS` and `CURL_CA_BUNDLE`, so `termag-status` goes over HTTPS too. The box front and the plain gateway answer `/termag/internal/` with 404, as the orchestrator's :3040 does, so the gateway's checks come only through the checks ALB front. Boxes also get `GIT_SSL_CAINFO` and `SSL_CERT_FILE` (git and `gh` ignore `CURL_CA_BUNDLE`), plus their own `GIT_CONFIG_SYSTEM` and `TERMAG_PROFILE_D` under `boxes/<name>/etc`, for what `termag-credentials` writes under `/etc` on a real box. |
| `E2E_BROKER_443=1` | The GitHub broker's port | With `E2E_CLAUDE_GATEWAY` and `E2E_FAKE_GITHUB=1` (the broker is a listener on the gateway): relays `127.0.0.1:443` to the gateway's GitHub front from the box address (`box-network.mjs`, log `broker-relay`) and gives the backend `GITHUB_BROKER_URL=https://localhost`. `gh` accepts a GitHub Enterprise host only as a bare hostname, so a broker has to be on 443. Binding it needs `sudo sysctl -w net.ipv4.ip_unprivileged_port_start=443` once; up.sh refuses to start without it. |
| `E2E_FAKE_BEDROCK=1` | The Bedrock runtime | `bedrock-stub.mjs` on `127.0.0.1:4690` (`E2E_BEDROCK_PORT`): `POST /model/<id>/invoke` and `invoke-with-response-stream` (AWS event-stream frames, as Bedrock sends them). A request without a SigV4 `Authorization` for service `bedrock` gets 403. Each call is logged in `GET /_e2e/calls` with the signer's access key, region and service, and whether a bearer token or any `x-termag-*` header came along; `logs/bedrock-invocations.jsonl` carries the request id and token counts, as Bedrock model-invocation logging does. A real Claude Code pointed at it can be driven through a tool: a user line `call <tool> <text>` gets a `ToolSearch` for the tool while it is deferred, then a `tool_use` with `{text}`, then a reply quoting the result (how the MCP broker demos call an MCP server's tool). |
| `E2E_CLAUDE_GATEWAY=<dir>` | The termag Claude gateway | Needs `E2E_FAKE_BEDROCK=1`, `E2E_TLS=1` and a backend with the gateway. `<dir>` is a checkout of the gateway's terraform: `claude-gateway.sh` renders its `modules/claude-gateway/envoy-config` with `terraform console` (`E2E_TERRAFORM`, default `terraform`) and the models in `claude-models.json`, pointed at the stub and the TLS listener, so the harness runs the same Envoy config production does. Envoy 1.39.1 (checksum-pinned, `envoy.sh fetch`) listens on `127.0.0.1:18080` (`E2E_CLAUDE_GATEWAY_ENVOY_PORT`, admin on the next port), behind an nginx TLS front on `localhost:3643` (`E2E_CLAUDE_GATEWAY_PORT`) standing in for the ALB. The backend gets `CLAUDE_GATEWAY_URL`, `CLAUDE_BEDROCK_*` and the default/fast tiers. With `E2E_FAKE_CLAUDE=1`, `claude -p [--model <tier or id>] <prompt>` on a box reads the managed settings, runs `apiKeyHelper` (which prints the box's agent token) and streams through the gateway. Both of Envoy's listeners send every request to the backend's `ext_authz` checks through the TLS listener: the Claude listener to `/termag/internal/claude-authz`, and the GitHub listener (Envoy port + 2, behind a TLS front on `localhost:3644`, `E2E_GITHUB_BROKER_PORT`) to `/termag/internal/github-authz`, upstream to the `E2E_FAKE_GITHUB` stub. `logs/claude-gateway.log` is Envoy's access log. The checks' caller proof (loopback listeners on Envoy port + 3 and + 4) is checked by `fakes/sts-stub.mjs` on `127.0.0.1:4691` (`E2E_STS_PORT`), which verifies the SigV4 signature for real with the harness's gateway key, so a proof passes only if Envoy signed exactly what the backend replays. The backend gets `GATEWAY_AUTHZ_ALLOWED_CALLER_ARNS` (the stub's gateway role) and `GATEWAY_AUTHZ_STS_URL`. |
| `E2E_FAKE_MCP=1` | The MCP broker and a remote MCP server | Needs `E2E_CLAUDE_GATEWAY` with a checkout whose gateway has the MCP broker listener (Envoy port + 6, rendered with `127.0.0.1/32` as its only allowed upstream range). `mcp-upstream.mjs` serves Streamable HTTP on `https://localhost:4693/mcp` (`E2E_MCP_PORT`, the stack's certificate) and wants `Authorization: Bearer e2e-mcp-secret`; `GET /_e2e/calls` logs each request with whether it carried that credential or any box token. The broker listener sits behind its own TLS front on `localhost:3646` (`E2E_MCP_BROKER_PORT`) and checks each request at `/termag/internal/mcp-authz`. The backend gets `MCP_BROKER_URL` and `MCP_UPSTREAM_TEST_ALLOW=localhost:4693`, the one loopback upstream a connector may name. |
| `E2E_SSHD=1` | SSH to a box | One unprivileged sshd per box on `127.0.0.1:2220+N` (`E2E_SSH_PORT_BASE`), reading that box's `~/.ssh/authorized_keys`. A login lands in the box's home with its `PATH` and tmux server. `StrictModes` is on only when no directory above the root is group- or world-writable, which `/tmp` is; start with `TMPDIR` set to a `0700` directory to get it. |
| `E2E_EC2_BOXES=N` | Orchestrator-launched boxes | The first N boxes are created as `kind=ec2` through `POST /api/instances`. With no box provisioning configured the API returns a token, as for a hand-built box, and the box goes `provisioning` → `ready` when its agent connects. With `E2E_EC2_LAUNCH=1` they are launched through box provisioning instead (next row). |
| `E2E_EC2_LAUNCH=1` | Box provisioning end to end: **Add box** launches a box, **Terminate** stops it | Needs `E2E_FAKE_AWS=1`. Turns on the backend's box provisioning (`BOX_*` env, a registered box image in Floci) and points only its EC2 client at `fakes/ec2-launcher.mjs` on `127.0.0.1:4567` (`E2E_EC2_PORT`, `4587` on macOS; via `AWS_ENDPOINT_URL_EC2`), which forwards to Floci. Floci starts nothing and drops `UserData`, so the proxy reads the agent token out of `RunInstances`' user data and starts a stand-in box with `scripts/e2e/box.sh` under `boxes/<BoxName>` (`.2`, `.3` when a terminated box had the name); `TerminateInstances` stops its agent and tmux server. `CreateSnapshot`, which Floci does not support, is answered by the proxy and recorded in `<root>/ec2/snapshots/<id>.json` (a box quarantine's snapshots). **Stop box** / **Start box** go through the same proxy: `StopInstances` kills the box's agent and tmux server, as powering a machine off does, and `StartInstances` runs `box.sh` again on the same home. Each box keeps its own boot id in `boxes/<name>/boot_id` (`TERMAG_BOOT_ID_FILE`, since the stand-ins share this machine's kernel): a `StopInstances` removes it, so the next start is a new boot to the chat runner, while `ctl.sh restart` keeps it. The `E2E_EC2_BOXES` boxes are launched this way too. Floci keeps no image tags on `DescribeImages`, so the proxy adds each image's tags from Floci's `DescribeTags` and applies `tag:` filters itself: the backend's tag-based AMI discovery runs as against EC2. `ctl.sh ec2 bake` registers a newer image (`ctl.sh ec2 bake Component=box-candidate ...` overrides or adds tags, e.g. to bake an image discovery must not see), `ec2 clear` deregisters them all (the next launch fails with `No box AMI found`), `ec2 no-agent` / `ec2 agent` makes launched and started instances start no box / a box again, and `ec2 ignore-stop` / `ec2 honor-stop` makes the proxy accept a `StopInstances` without passing it on, so the instance keeps running. A repository's environment.json requirements work too: the proxy answers `GetInstanceTypesFromInstanceRequirements` from a small Graviton catalog (m/r/c, 7g and 8g; `DescribeInstanceTypes` gives those types their vCPUs and memory) and logs each request to `<root>/ec2/requirements`. **Hibernate box** works too, with an image from `ctl.sh ec2 bake Hibernation=supported`: the proxy answers `DescribeInstanceTypes`, remembers which instances launched with `HibernationOptions` (a hibernate of any other answers `UnsupportedHibernationConfiguration`), freezes a hibernated box's agent and tmux server with SIGSTOP so its sessions survive, thaws them on `StartInstances`, and reports `Client.UserInitiatedHibernate` as the `StateReason`; `ec2 refuse-hibernate` / `ec2 allow-hibernate` makes every hibernate answer EC2's "not ready to hibernate yet", for the fallback to a plain stop. **Resize box** (`docs/box-provisioning.md`) works too: the proxy answers `ModifyInstanceAttribute` (a `DryRun` with `DryRunOperation`), keeps the new type in `<root>/ec2/<id>.type` and reports it in `DescribeInstances`, and offers every type in `DescribeInstanceTypeOfferings`; `ec2 no-capacity-type <type>` / `ec2 type-capacity` makes a `StartInstances` of an instance of that type (the type a resize or a start's retype set, else the one it launched as) answer `InsufficientInstanceCapacity`, so the resize, or a start's same-shape fallback, walks to the next type. `ec2 no-start-capacity <subnet>` / `ec2 start-capacity` makes every `StartInstances` of an instance launched in that subnet answer it whatever its type: a zone with no room, for an environment pool claim's fallback to a box in another zone. `ec2 hold-terminate` / `ec2 release-terminate` makes `DescribeInstances` report a terminated instance as `shutting-down`, so `terminateBox` keeps waiting as it does on EC2 for minutes, long enough to restart the backend mid-teardown (`scripts/e2e/box-teardown.test.sh`, `make e2e-test-box-teardown`, sets `BOX_TEARDOWN_RETRY_SECONDS` / `BOX_PROVISIONING_SWEEP_SECONDS` through `E2E_BACKEND_ENV`). Set `BOX_START_TIMEOUT_SECONDS` / `BOX_STOP_TIMEOUT_SECONDS` through `E2E_BACKEND_ENV` to see those two cases time out in seconds rather than minutes. |
| `E2E_OVERLAP=1` | Overlapping deploys | The orchestrator lease on with second-scale timings, a second backend ready as `ctl.sh start backend-green` on `E2E_GREEN_PORT` (default `E2E_PORT + 3`), and the box network routing like the ALB: it polls each backend's `/termag/health/serving` and sends new connections only to serving ones. `scripts/e2e/overlap.test.sh` (`make e2e-test-overlap`) drives it. Not with `E2E_TLS`. |
| `E2E_TMUX_FAULTS=1` | A slow or wedged tmux | Each box's tmux wrapper reads `<root>/boxes/box-N/tmux-fault`: `ctl.sh fault box-1 hang` makes `capture-pane` and `display-message` never return, `attach-delay=2` sleeps before the agent's pre-attach `set-option -g set-clipboard`, `off` passes through. Changes take effect on the next tmux call. |
| `E2E_WARM_POOL=N` | The warm pool: N pre-provisioned boxes Add box can claim | Needs `E2E_EC2_LAUNCH=1`. Sets `WARM_POOL_TARGET_SIZE=N` and `WARM_POOL_RECONCILE_SECONDS` (`E2E_WARM_POOL_TICK`, default 5), so the backend's reconciler launches pool boxes through the launch fake, which recognizes their user data (`buildWarmCloudInit`): the agent config keeps `warm: true` and the pool marker lands in `~/.termag/pool.json`. A pool box also gets a `systemctl` stand-in (`fakes/systemctl`) that runs `termag-on-warm.service` and `termag-on-claim.service` from their unit files in `deploy/` (each run in its own process group, pid in `pids/`), and a `~/src/termag` whose `deploy/on-warm.d` is `fakes/on-warm.d`: one script that sleeps `E2E_WARM_SECONDS` (default 2; set it, or `E2E_WARM_EXIT`, in the box's `~/.termag/e2e-warm.env`), since the real ones run first-boot setup and pull images. With `E2E_FAKE_GITHUB=1`, github.com is the stub for a pool box's git (its system gitconfig), and the stub serves a public `e2e-org/dotfiles` (anonymous clone; its `install.sh` takes `E2E_DOTFILES_SECONDS`, default 3, from the box's `~/.termag/e2e-dotfiles.env`, and writes `~/.e2e-dotfiles-applied`). `e2e-org/sample` stays private. |
| `E2E_OTLP_SINK=1` | The host's OpenTelemetry collector | `fakes/otlp-sink.mjs` on `127.0.0.1:4695` (`E2E_OTLP_PORT`) takes the backend's OTLP/HTTP JSON (`/v1/metrics`, `/v1/logs`, `/v1/traces`) and prints a line per metric point and log record in `logs/otlp.log`, as the collector's debug exporter would; nothing goes further. The backend gets `OTEL_EXPORTER_OTLP_ENDPOINT` and a 5 s `OTEL_METRIC_EXPORT_INTERVAL`, so product events and metrics show up within seconds. `E2E_OTLP_FILTER=<substring>` keeps only lines with it (e.g. `releas`); `GET /_e2e/lines` returns the lines kept. |
| `E2E_FLAGS=<json>` | Feature flags, for a flag a feature is gated on | A JSON object of flag key to value, e.g. `'{"warm-pool-enabled":true}'`, passed as `TERMAG_FLAGS` (`backend/src/services/featureFlags.ts`). Server-side reads see it, and the browser gets it from `GET /api/flags`, where `useFlag` reads it. Flags production turns on together follow each other unless the object names them: `simple-ui-reviews-enabled` on brings `simple-ui-review-clone-enabled`, so Review on a PR whose repository has no project here clones one, as in production (`e2e_flags_like_production`, `scripts/e2e/lib.sh`). |
| `E2E_PG_IAM=1` | The orchestrator's database on Aurora | Runs `deploy/termag-rds-bootstrap.sql` against the stack's Postgres (with a stand-in `rds_iam` role), then gives the backend the RDS `.env`: no `DATABASE_URL`, `PG_IAM_AUTH=true`, `PG_USERNAME=application`, and `TERMAG_DATA_DIR=<root>/data` with `ALLOW_EMPTY_DATABASE`. The schema sync runs as `migration` with `DB_PUSH_MODE=additive`, then `db:guard` runs as cloud-init does (`logs/db-guard.log`). up.sh fails unless the running backend's connections are all `application`. Tokens are minted locally with dummy keys (Floci's when `E2E_FAKE_AWS=1`). The cluster trusts local connections, so it never asks for them: what this covers is the IAM pool, Prisma's driver adapter, the session store on that pool, and the role grants, not token validation. |
| `E2E_BACKEND_ENV=<file>` | A feature's own settings | Appended to `<root>/backend.env` before the backend starts. |

Seed and inspect Floci without the AWS CLI:

```bash
bash scripts/e2e/fakes/aws.sh mb termag-snapshots-local
bash scripts/e2e/fakes/aws.sh call TrentService.CreateKey '{}'
bash scripts/e2e/fakes/aws.sh call AmazonSSM.PutParameter \
  '{"Name":"/termag/example/parameter","Value":"UNSET","Type":"SecureString"}'
```

A seed for `E2E_AWS_SEED`, here what the auth-once work expects the
terraform to have created: the per-user credentials' KMS alias.

```bash
set -e
key=$(aws.sh call TrentService.CreateKey '{}' | jq -r .KeyMetadata.KeyId)
aws.sh call TrentService.CreateAlias "{\"AliasName\":\"alias/termag-user-credentials\",\"TargetKeyId\":\"$key\"}" >/dev/null
```

On Linux, Floci is downloaded once, without Docker: `scripts/e2e/fakes/floci.sh`
fetches the image's native-binary layer (about 70 MB) from Docker Hub by pinned
digest, checks it, and unpacks it into `${XDG_CACHE_HOME:-~/.cache}/termag-e2e`
(`E2E_CACHE_DIR`). That cache is the only thing the harness keeps outside the
temp root. There is no native macOS build, so there it runs from the
`floci/floci` image in Docker instead (`E2E_FLOCI=docker` above; the image is
pulled on first use). Either way it runs with `floci.services.ec2.mock=true`,
which keeps the EC2 API but starts no instances and no metadata server (that
server would listen on all interfaces).

What the fakes don't prove, so PRs still call these out:

- Floci's `DescribeImages` returns no tags and ignores `tag:` filters, and
  `RegisterImage` drops `TagSpecifications`. With `E2E_EC2_LAUNCH` the proxy
  repairs `DescribeImages` for the backend's EC2 client (tags set with
  `CreateTags`, as `ctl.sh ec2 bake` does); a client talking to Floci directly
  still gets untagged images. `ModifyVolume` and `DescribeVolumesModifications`
  answer "not supported". `CreateRole` drops `PermissionsBoundary`. `GetParameter` returns a
  SecureString in plaintext even without `WithDecryption`. Nothing checks IAM,
  KMS key policies or bucket policies.
- A launched box never runs cloud-init: no user rename, home-path rewrite or
  git identity from user data, and it dials the stack's agent URL rather than
  the one in its user data, so it follows `E2E_TLS`. Instances are `running`
  as soon as `RunInstances` returns. A box that never connects stays
  `provisioning` until the backend's 15-minute sweep fails it. Floci moves an
  instance to `stopped` or `running` at once, so a real stop's minute or two
  of `stopping` and a real boot's start-to-ready time are not reproduced.
- The warm pool's boxes are stand-ins: no cloud-init, no systemd (the
  `systemctl` stand-in only knows the termag-on-* units and the durable
  clone), and a warm-up
  that sleeps instead of a deployment's own warm-up hooks.
  What is real is the backend (reconciler, claim, flags) and `agent/agent.js`.
- The Claude stub is not Claude: the settings `env` block, `apiKeyHelper` and whether a
  real `claude --resume` accepts a moved session are untested.
- The GitHub stub is not GitHub: SSO, org access and SSH with a registered key
  are untested, and only `fetch` is redirected.
- A stored GitHub token (`PUT /api/cli/v1/github`, Settings) reaches a box only
  through the GitHub broker, which is the Claude gateway's (`E2E_CLAUDE_GATEWAY`,
  Linux). Without it a box's git reaches the stub with no credential, so a
  clone of a private stub repository (`e2e-org/sample`) fails (`could not read
  Username`, in the project's `setupError`); tests that clone one touch
  `<root>/github/e2e-org/sample.git/termag-e2e-public` first (`ask-box.test.sh`,
  `cli.test.sh`, `t3-newbox.test.sh`). `E2E_REAL_GITHUB` puts your own
  credentials where the broker would be, for fetches only.
- The durable clone runs under the `systemctl` stand-in, not systemd: no
  `TimeoutStartSec`, no cgroup, and the unit inherits the agent's environment.
  The clone itself is the real `agent/project-clone.js`.
- Dotfiles are linked, not installed (`E2E_DOTFILES_REPO`): an entrypoint's
  effects are untested here.
- The TLS fronts are the harness's nginx, not the ALBs: each has a per-stack CA,
  which boxes trust through their process env and Envoy through its CA file. The
  real ALBs have public ACM certificates, and no Okta or security group is modelled.
- Credential delivery merges the Claude gateway keys into the box HOME's
  `~/.claude/settings.json`. Every box's agent runs with
  `TERMAG_CLAUDE_MANAGED_SETTINGS` pointing at
  `<root>/boxes/<name>/etc/claude-code/managed-settings.json` (where an earlier
  revision wrote them; delivery removes that file) and
  `TERMAG_CREDENTIALS_SUDO` empty, so no step needs sudo. The real `/etc`
  path and its sudo rule are untested.

### The fake Claude

`E2E_FAKE_CLAUDE=1` puts `scripts/e2e/fakes/claude` on each box's `PATH`. It is described one behaviour per bullet. Teach it something new as a bullet of its own (a new prompt word goes in its sorted place under "Prompt words"), not as more words in another bullet: this used to be one table cell on one 9 KB line, and every PR that taught the fake something conflicted there.

In a pane (no `-p`):

- It keeps conversations where Claude does, honors `--resume <id>` and `--continue` after other flags (Open in full UI execs `claude --permission-mode … --resume <id>`), and reports `idle`/`working` through `termag-status` as the hooks do.

The simple UI's chat runner (`claude -p … --output-format stream-json`, `agent/chat-runner.js`) runs `fakes/claude-stream.mjs` instead:

- The prompt on stdin, Claude Code's stream-json events (init, `--include-partial-messages` deltas, two real tool calls in the cwd, a markdown answer with a code block, a result with the real elapsed time and a cost that grows with the answer) and a transcript in Claude's shape, so `--resume <id>` and the runner's history work.
- `E2E_STUB_DELAY_MS` (default 30, or set in a box's `~/.termag/e2e-claude.env`) paces the streamed words.
- With `E2E_CLAUDE_ANSWER_PAD=<words>` (the env or a box's `~/.termag/e2e-claude.env`) a turn first streams that many words, a millisecond apart (`step 1, step 2, …`), ahead of its tool calls, so a few thousand make a turn whose history replay is only its newest lines (`TURN_EVENTS_MAX` in `agent/chat-runner.js`).
- `/compact` on a resumed session compacts it as Claude Code does headless (a `compact_boundary` with the last reply's context as `pre_tokens`, the summary, a `local_command` result; later turns count only what came after it, so the ring drops).
- In a live turn (`--input-format stream-json`) a later user line (a live chat message, or an ask follow-up steered into the turn) is taken in as Claude Code 2.1.310 does: one that arrives while it works, the first answer or a background wake-up, goes in at the next tool boundary and is folded into that answer, one result, and the transcript keeps it only as a `queued_command` attachment; one that arrives while the turn only waits starts a query of its own (an `init`, a user line, an answer, a result). Each is replayed when taken in under `--replay-user-messages`, and the process exits once stdin has closed, the background tasks have ended and every line is answered.
- It takes an `interrupt` control request as Claude Code does: mid-turn the open tool call is refused (`[Request interrupted by user for tool use]`), the turn ends with an `error_during_execution` result and the background tasks go on; once answered it is a no-op. SIGINT still ends everything at once.
- A message carrying a ```` ```ui-action ```` fence (a generative UI answer) is read back with what it carried and whether the turn had generative UI's system prompt (`--append-system-prompt-file`); `scripts/e2e/genui.test.sh` (`make e2e-test-genui`) drives that loop.
- A message with images gets its images answered from their bytes (type, size, a PNG's average colour) instead of the tour.
- A turn with `--effort <level>` says so at the end of its answer.
- A message that opens with a `<termag-box-notice>` (the box restarted, or the chat continues on a new box: `docs/chat-resume.md`) gets that notice quoted back at the top of its answer, and the rest is read as the prompt.
- A message that opens with termag's ask finish notice (`[termag] Your ask … finished: …`) is answered as an orchestrator would: in a trusted chat it runs `termag ask --inbox` first, then it names each finished message and its state and says it reads the handoffs next.
- Its messages and results carry token usage in Claude Code's shapes against a 1M context window, for the composer's context ring, and once the box is signed in each turn sends a `rate_limit_event` as a Claude Enterprise seat does: one extra-usage window with no utilization, resetting at the start of next month. A box's `~/.termag/e2e-claude.env` can set `E2E_CLAUDE_PLAN=pro` or `max` for those plans' 5-hour and 7-day windows instead, and `E2E_CLAUDE_CONTEXT_WINDOW=200000` to fill the ring in a few turns.
- Like Claude Code on Bedrock, which is every real box, it writes no `ai-title` line; `E2E_CLAUDE_AI_TITLES=1` (in the env or the box's `~/.termag/e2e-claude.env`) writes the one Claude Code writes on the first-party API, from the prompt's first words.
- It honours `--tools` (an untrusted chat's runner passes only `Read,Grep,Glob`, so the listing is a Glob, not Bash) and, when Bash is listed, refuses it outside `bypassPermissions`/`acceptEdits` with Claude Code's permission error; a trusted chat runs `bypassPermissions` with every tool, so the listing is `ls`.
- A box's `~/.claude/expired` makes every `claude -p` turn fail as an expired seat does (Claude Code's `authentication_failed` message and a 401 result) while `auth status` still says logged in, for the chat's sign-in card coming back; a successful login removes it.

Prompt words, in alphabetical order (a prompt that starts with the word):

- `asks` (trusted chats only): an orchestrator's fan-out, three prompt files written and then three real `termag ask --no-wait` calls to `E2E_ASK_TARGET` (default `box-2/sample`; the env or a box's `~/.termag/e2e-claude.env`), run with the box's own `termag`, so the threads, their chats on the target and the parent link are real, for the chat's ask rows. A box without the CLI on its `PATH` gets the shell's error as the calls' output.
- `background`: runs three Bash calls with `run_in_background` (the last a `termag ask`), reports them in `background_tasks_changed` events, and keeps the turn open after its answer while they run, for the composer's Stop confirm and split Stop (`long background` streams it ten times slower): they end one by one over `E2E_BACKGROUND_MS` (default ten minutes; the env or a box's `~/.termag/e2e-claude.env`), unless stopped, and each end wakes the same process as Claude Code's does (`task_updated`, a `task_notification` naming the call, the tasks left, a new `init`, then a Read of the task's output, an answer and its own `result`, with the notification in the transcript as a `<task-notification>` user line), for the chat's "Working · background task finished" and "Your turn · N background tasks running".
- `genui`: answers with generative UI: ```` ```spec ```` fences from `fakes/genui/*.jsonl` (`genui rollout`, `genui review`, `genui plan`, `genui dashboard`, `genui outbox` or `genui feedback` for one demo, `genui` alone for all six), drawn as UI with `chat-generative-ui-enabled` on.
- `long`: in a pane, stays `working`; in the chat runner, streams ten times slower.
- `markdown`: answers with every element the chat's markdown renderer reads (a GFM table with alignment, nested and task lists, a quote holding a list, strikethrough, autolinks, an image link, escapes and raw HTML that stays text).
- `quiet`: `quiet survey` (or `long quiet survey`) runs the same calls as `survey` with no sentence before them, and `quiet check` only the listing and the README read with none (a two-call run).
- `run`: only in the Agent SDK mode below.
- `skill`: first loads a `termag-spaces` skill as Claude Code does (a `Skill` call answered `Launching skill: …`, then the SKILL.md as a synthetic user message: `isSynthetic` live, `isMeta` with `sourceToolUseID` in the transcript), for the chat's collapsed skill row.
- `subagents` (trusted chats only): three Agent calls in one message as Claude Code 2.1.312 makes them, two in the foreground and one in the background, for the chat's subagents: each one's `task_started`, its own messages under its call (`parent_tool_use_id`) with `task_progress` between its steps, `task_updated` and `task_notification`, and its transcript in `<session>/subagents/agent-<id>.jsonl` with a `.meta.json`. The foreground pair hand back their reports in the call's result (`tool_use_result` live, the framed text in the transcript); the background one's result says it launched, and it ends after `E2E_SUBAGENT_MS` (default 15 s; the env or a box's `~/.termag/e2e-claude.env`) with a `<task-notification>` carrying its `<result>`, waking the same process as `background` does.
- `survey` (or `long survey`): opens with a lead-in sentence and runs six more shell commands after the listing, each with a description as Claude gives one, the fourth failing (a long run of tool calls for the chat's collapsed tool rows and their header).
- `triage` (trusted chats only): runs three runs of two calls with Claude's text between them (reproduce a failing test, find where the port is read, fix it and rerun), for the runs' headings.

Other modes:

- Without `-p` and with `--input-format stream-json` (the Claude Agent SDK's long-lived mode, as a box's t3 server drives it with `E2E_T3=1`) it runs `fakes/claude-sdk.mjs`: it answers the SDK's control requests (`initialize` with an account, `mcp_set_servers`, `interrupt`, the rest with an empty success), runs one turn per user message ("Stub Claude here (turn N, mode) … You said: …", streamed with `--include-partial-messages`) in the transcript the SDK names with `--session-id=<id>`, and goes on with that transcript and its turn count on `--resume=<id>` (so a thread that carries on after its t3 server came back, a box stopped and started, reads turn 2).
- In that SDK mode, a prompt starting with `run` calls Bash after asking the SDK with `can_use_tool` unless the mode is `bypassPermissions`/`acceptEdits`, and runs the hooks of the settings Claude Code would load (SessionStart, UserPromptSubmit, Pre/PostToolUse around the Bash call, Stop; `/bin/sh` in the cwd with the event's JSON on stdin and `CLAUDE_PROJECT_DIR`): with `E2E_T3` a box carries `deploy/claude-settings.json` as `~/.claude/settings.json` and `termag-status` in `~/.local/bin`, so a desktop turn reports status as on a real box. `E2E_STUB_LOG=<file>` records every line in and out (t3's MCP credential among them).
- With `--output-format json` it is the box's own title call (`agent/session-title.js`): the opening message on stdin and a title made of its first words as one result, with nothing written.
- The chat runner's tool-group heading call (`agent/tool-group-headings.js` through `agent/haiku-oneshot.js`, whose `--system-prompt` describes a "group of tool calls"; the session-title call passes the same flags with its own prompt) runs `fakes/claude-json.mjs`: the run's JSON (its first call) on stdin and, after `E2E_HEADING_DELAY_MS` (default 1200; the env or a box's `~/.termag/e2e-claude.env`), one JSON result. For the `triage`, `survey`, `quiet survey` and `quiet check` runs that is the heading real Haiku wrote for the same run with the start-of-run prompt (recorded 2026-10-28); any other run gets one made from its first call. `E2E_HEADING_FAIL=1` makes every heading call fail, for the fallback.
- `--version` answers as Claude Code does.
- `claude auth status` and `claude auth login --claudeai --sso` stand in for Enterprise sign-in (`fakes/claude-auth.mjs`): a gateway `apiKeyHelper` or `CLAUDE_CODE_USE_BEDROCK` counts as already logged in, and a login reads one `code#state` line (`E2E_CLAUDE_LOGIN_CODE`, default `e2e-login#e2e-state`) without echoing it.

## Recording UI checks

Before a PR that changes the UI or the box protocol:

1. `make e2e-status` (or `make e2e-up`).
2. Open the UI in the browser and sign in. You should see the boxes and the
   `sample` project.
3. Walk the flow the change is about. The baseline: create a project on a box,
   open its terminal and type in it, send a status from its pane, and create a
   project with the same name on the other box.
4. Record the screen while you do it for a new flow, or take screenshots for
   a small visual change (`docs/demos.md` has which format when). Put
   them in the PR as artifacts, not in the branch.
5. `make e2e-down` if you need a clean slate. `make e2e-up` again takes a few
   seconds.

`make e2e-test` runs the baseline flow without a browser and is the quickest
way to check a change to the stack itself.

`scripts/e2e/multi-repo.test.sh` (in `make e2e-test`, alone `make
e2e-test-multi-repo`) brings up its own stack with `E2E_FAKE_GITHUB=1` and
`multi-repo-projects-enabled` on, and drives a multi-repo project
: created from
`e2e-octocat/shop-web` and `shop-api`, cloned into a folder that is not a
repository, branched off, refused a workstream removal while the workstream
folder holds a stray file, and removed with force.
`scripts/e2e/multi-repo-rename.test.sh` (in `make e2e-test`, alone `make
e2e-test-multi-repo-rename`) renames such a project with two workstreams, then
one workstream, and checks after each that `git status` works in every
checkout and worktree, git lists the worktrees at their new paths, the
generated guides carry the new names (a hand-written one is kept) and the
tmux sessions follow.
`scripts/e2e/multi-repo-add.test.sh` (in `make e2e-test`, alone `make
e2e-test-multi-repo-add`) adds the stub's `e2e-octocat/shop-docs` to such a
project with a workstream and checks it is cloned beside the running
sessions, checked out in the workstream on its branch and listed in the
guides; that Branch off waits for the clone and a later workstream has it;
that adding it twice is refused; and that a repository that cannot be cloned
fails alone, the project and its sessions carrying on.
`scripts/e2e/multi-repo-prs.test.sh` (`make e2e-test-multi-repo-prs`) adds
`E2E_FAKE_AWS=1` and `E2E_CREDENTIAL_STORE=1`, so the user can store a stub
GitHub token, seeds a public `example-org/termag` in the stub, and makes a
project of it and `shop-web` with a workstream on the stub PR #4244's branch:
`GET /api/prs` links #4244 to it and lists shop-web's branch, the Review pane
refuses a bare number and opens in the PR's repository, and a spawn row's
retire is kept for shop-web's unpushed commit, then removes the workstream.
`scripts/e2e/multi-repo-pr-checkout.test.sh` (`make
e2e-test-multi-repo-pr-checkout`), on the same fakes, makes a project of
`shop-web` and the stub's `example-org/e2e-demo`, pushes PR heads to
`refs/pull/<n>/head` in the bare repository (`own-prs.json` and `pr-heads.json`,
keyed `<owner>/<name>#<n>`), and checks a PR out with New workstream for #N: the
PR's branch in e2e-demo's worktree, shop-web's worktree on the same branch, the
refusals, and an undo that keeps the PR's branch.

## Setting up a scene

Recipes for putting the stack in a state a check or a demo needs
(`docs/demos.md` is about recording it). Write rows in the stack's own
Postgres (`psql -h 127.0.0.1 -p 55432 -U termag termag`), never anywhere
else. Tables are the `@@map` names in snake_case (`instances`, `users`,
`session`), and their columns are camelCase, so quote them (`"hibernatedAt"`,
`"provisioningError"`). Grant access through the API as the signed-in user,
not in SQL, so the app's own rules apply. Run a seed with several commands as
a bash script: zsh doesn't word-split an unquoted `$PSQL`.

- **Boxes in every state.** Stand-in boxes are `external`: no Start or Stop,
  and `ready` while their agent is connected. For a list or sidebar showing
  running, stopped, hibernated and errored boxes side by side, `make e2e-up
  E2E_BOXES=8`, create a project on each box (`POST /api/projects`), then
  `ctl.sh stop box-N` and set its row: `update instances set status='stopped'
  where name='box-3'` (and `"hibernatedAt"`, `"provisioningError"`). A row set
  to `starting` with its agent stopped stays `starting`. Unsaved-work and
  auto-park notes can't be faked this way. When the scene must press Start or
  Stop, use `E2E_EC2_LAUNCH=1` instead.
- **A stopped EC2 box with a stored chat.** Append
  `CHAT_TRANSCRIPT_ALLOW_PLAINTEXT=1` to `<root>/backend.env` and `ctl.sh
  restart backend`, or nothing is stored. Send a turn or two to a
  `claude-chat` project (`POST /api/projects/<id>/chat/messages` with a curl
  cookie jar from `/auth/login`) and check `chat_transcripts`. Then `ctl.sh
  stop box-1` and `update instances set kind='ec2', "ec2InstanceId"='i-0e2e…',
  status='stopped'`: the frontend offers a start only for `kind='ec2'` with an
  instance id. Without the launch fake, answer `**/api/instances/*/start` in
  Playwright with a 202, and from the handler set `status='starting'` and
  `ctl.sh start box-1`; the agent's hello makes it `ready`.
- **A busy box with no agent working.** `update instances set
  "sshSessions"=1, "hostSampledAt"=now()` (the ssh busy check), and set both
  back to null after.
- **The simple UI's session header.** `SessionHeader` (the ⋯ menu with Archive
  and Open in full UI) is `SdkChatView`'s, a `claude-chat` project's. The
  seeded `sample` is a pane chat (`ChatView`), with the older header. Create
  one with the CLI signed in through `scripts/e2e/cli-login.sh`: `termag
  project create box-1/x --agent claude-chat`.
- **A review queue for the Reviews page.** `make e2e-up E2E_FAKE_GITHUB=1
  E2E_FAKE_AWS=1 E2E_CREDENTIAL_STORE=1
  E2E_FLAGS='{"simple-ui-chrome-refresh-enabled":true,"simple-ui-reviews-enabled":true}'`,
  then `scripts/e2e/scenes/review-queue.sh`. It copies `review-queue.json` (12
  review requests across four repositories: every review state, two bot
  authors, a draft, a failing CI run) to the stub's `review-prs.json`, which
  its review search adds to #4242, and stores a stub GitHub token for the
  e2e user, so `/chat/reviews` and its filters have something to filter.
- **Admin pages.** Append `ADMIN_USERS=e2e@termag.local` to
  `<root>/backend.env` and `ctl.sh restart backend`; the browser session
  survives the restart.
- **A project from any GitHub repository.** With `E2E_FAKE_GITHUB=1` a box's
  clone of `https://github.com/<owner>/<repo>` goes to the stub, which serves
  only the bare repositories under `<root>/github`, and a private one fails
  without a broker (above). Before the create, `git init -b main` a scratch
  directory with one commit, `git clone --bare` it to
  `<root>/github/<owner>/<repo>.git`, and touch `termag-e2e-public` in it.
  Never do this in the real repository.
- **An automation that runs.** `termag automation create box-1/x --every 15m
  --from https://github.com/e2e-org/sample - < prompt.md` on box-1's
  credentials, after touching `<root>/github/e2e-org/sample.git/termag-e2e-public`
  (otherwise Run now answers 502 "clone failed"), and with
  `E2E_CLAUDE_SIGNED_IN=1`, or the "Sign in to Claude Enterprise" card covers
  the run. A run's conversation is `/termag/chat/p/<projectId>?ws=<run
  workstream>`; without `ws` the page shows main's empty chat. `rm` archives
  the project and a create with an archived name is 409 `archived_name`, so
  each take needs a new name.
- **Run history without running it.** Create the automation `--paused`, then
  per run insert a `workstreams` row (named `run-<yyyymmdd>-<hhmm>`), a
  `workflows` row (`type 'agent'`, `provider 'claude-chat'`, the same project
  and workstream) and an `automation_runs` row (`state`, `"scheduledFor"`,
  `"workstreamId"`). `update automations set enabled=true` so the subtitle
  shows the schedule. A run's status is `HOME=<box home>
  TERMAG_E2E_ROOT=<root> TERMAG_STATUS_SESSION=<user>-<automation>-<run>-agent
  <root>/boxes/<box>/bin/termag-status working`.
- **A second user.** Local sign-in only ever signs in the first `ALLOWED_USERS`
  identity (`routes/auth.ts`). To act as another person (a viewer, someone
  without access): insert them into `users` (`id`, `googleId`, `googleEmail`,
  `unixUsername`, `displayName`, and `onboardedAt = now()`, or they get
  onboarding), insert a `session` row whose `sess.passport.user` is that id,
  and send the sid as the `termag.sid` cookie, signed with `SESSION_SECRET`
  from `<root>/backend.env`: `encodeURIComponent('s:' + sign(sid, secret))`
  with `cookie-signature`'s `sign`. In Playwright, `context.clearCookies()`
  then `addCookies([{ name: 'termag.sid', value, domain: 'localhost', path:
  '/termag' }])` swaps users within one recording. A feature that re-checks
  `ALLOWED_USERS` on each request (shared files do) 404s for them until they
  are in it too: edit `ALLOWED_USERS=e2e@termag.local:<you>,riley@termag.local:riley`
  in `backend.env` and restart the backend. Every local sign-in, the
  unrecorded one that makes a `storageState` included, resets the first
  user's `displayName` to "Dev User", so rename them after that, or "Shared
  by …" reads Dev User.

## A demo environment

`.termag/demo/environment.json` is an environment definition
 that brings this stack up on a termag
box, so a person gets a preview URL to click around in. It is used through a
pointer environment, never as the repository's own file, so other termag
boxes keep their size. To create it, go to Environments, then New. Use the name
`termag-demo`, kind Pointer, repository `example-org/termag`, branch empty
(the default branch), and path `.termag/demo/environment.json`. Then start a
New session with that environment, or run `termag project create
<box>/<name> --agent claude --new-box --environment termag-demo`.

| Key | Value |
|---|---|
| `resources` | `{ "vcpu": 2, "memoryGiB": 8, "diskGiB": 50 }`: the small preset (m8g.large). The full image's root snapshot is about 128 GB, and a box's disk never goes below its image's (`amiWithDisk`), so today the 50 GB is lifted to that floor. Only a minimal-image box can have a 50 GB disk. |
| `setup` | `bash .cursor/install.sh`: apt packages (PostgreSQL, tmux, jq, nginx, sshd), `npm ci` in `backend`, `frontend` and `agent`, the Prisma client, the backend build, and Floci for `E2E_FAKE_AWS`. |
| `run` | `scripts/e2e/down.sh`, then `make e2e-up` with `E2E_FAKE_GITHUB`, `E2E_FAKE_AWS`, `E2E_SPACES` (the spaces bucket and KMS alias that space uploads go to; without it every upload's PUT answers `NoSuchBucket`), `E2E_CREDENTIAL_STORE`, `E2E_FAKE_CLAUDE` and `E2E_CLAUDE_SIGNED_IN`, plus `E2E_FLAGS` turning on `simple-ui-chrome-refresh-enabled` and `simple-ui-reviews-enabled`. |
| `seed` | `scripts/e2e/scenes/review-queue.sh` (the Reviews page's queue, from #1290) when the checkout has it, else a line saying so; the stack's own seed (the e2e user, the `sample` project on `box-1`) runs inside `make e2e-up` either way. |
| `stop` | `make e2e-down`. |
| `ports` | `frontend` 5174 (health `/termag/`; `/` answers 302 to `/termag/`), `backend` 3040 (health `/termag/health`). |

The orchestrator reads `resources` when it makes the box. The steps are the
box's to run (environments PR B, #998: `termag-env up`; a pointer's file is
held, so its owner starts it). `backend/src/services/environmentSchema.test.ts`
holds the file to the schema and to the parser with no warning, and its run
step to `E2E_SPACES=1` while its flags turn spaces on.

Measured on a small box (2026-11-04, 2 vCPU, 7.6 GiB):
- setup took 1 min 13 s, run 13 s, and the seed with the scene under a second.
- Memory peaked at 3.1 GB used, with the stack seeded, a chat turn and a browser on Reviews. MemAvailable never went below 4.7 GB, and no swap was used.
- The stack adds about 2.6 GB of disk to what the image already uses (45 GB).

The seeded `sample` is a pane project, so a chat needs a new session.

## The termag CLI

`scripts/e2e/cli-doctor.test.sh` (`make e2e-test-cli-doctor`) brings up its
own stack with `E2E_FAKE_AWS=1`, `E2E_CREDENTIAL_STORE=1` and
`E2E_FAKE_GITHUB=1`. The laptop's `gh`, `aws` and `session-manager-plugin` are
stand-ins on `PATH`. It checks:

- `termag doctor` before sign-in;
- `login` at a terminal running doctor and accepting all three fixes: the token
  is stored encrypted and checked with the GitHub stub, the AWS profile is
  written and `aws sso login` runs;
- the SSH key left to the web UI: doctor prints the Settings link, registers
  nothing, and the key is then added through `/api/ssh-keys`;
- the SSO warning;
- report-only behavior without a terminal;
- the box token's 403 on `PUT /github`, and the CLI API's 404 for
  `POST /api/cli/v1/ssh-keys` with a device token, an access token and a box
  token;
- that the gh token never appears in any output.

`scripts/e2e/cli.test.sh` (`make e2e-test-cli`, also part of `make e2e-test`)
builds `cli/`, brings up its own stack and runs the CLI against it from a temp
`HOME`. A curl script on `PATH` as `xdg-open` stands in for the browser: it
signs in, loads `/auth/cli/authorize`, posts Authorize and follows the redirect
to the CLI's loopback. The checks cover the stored token, `whoami`, the box and
project lists, the box's own credential (`HOME` set to a box's home), the
approval page's same-origin guard, and signing out from both the CLI and the
web UI. The stack runs with `E2E_FAKE_AWS=1 E2E_EC2_LAUNCH=1`, so the lifecycle
checks create a real stand-in box with `box create --wait`, create, rename and
archive projects on it (checking its tmux server and directories), stop and
start it, and terminate it, plus the box-name rule and what a box's own token
may not do.

`scripts/e2e/cli-connect.test.sh` (`make e2e-test-cli-connect`, also part of
`make e2e-test`) covers `termag ssh`, `attach` and `ssh-config` with real ssh
against `E2E_SSHD=1`. It marks box-1 as an EC2 box in the database (instance id
`i-e2e0001`) and puts a stand-in `aws` on `PATH` whose `ssm start-session`
pipes to that box's sshd, so the SSM document, IAM, the Session Manager plugin
and AWS SSO are the only parts not exercised. The laptop starts with no
`~/.aws/config`, so the first connection writes the `[sso-session]` profile
and signs in once; the stand-in `aws` lists only the profiles that file has.
The laptop key reaches the box through the SSH-keys settings. An `ssh` wrapper on `PATH` names the laptop's
key and `known_hosts`, because ssh reads `~/.ssh` from the passwd entry, not
`$HOME`.

## Running on macOS

The stack runs on macOS as well as Linux, with these differences:

- There is no `setsid(1)`: `lib.sh` and the `systemctl` stand-in start each
  process group with perl's `POSIX::setsid` instead.
- There is no `/proc`, and macOS `ps` shows no other process's environment, so
  `down.sh`'s last sweep finds stragglers by a command line naming a path under
  the stack's root (agents, tmux servers, postgres) rather than by
  `TERMAG_E2E_ROOT`, among your own processes only and never the shell that
  ran it.
- Only `127.0.0.1` is on `lo0` until `sudo ifconfig lo0 alias 127.0.0.2`.
  Without the alias `box-network.mjs` says so once and connects the boxes from
  `127.0.0.1`, which the backend takes for the orchestrator itself: box status
  pills stay empty.
- `E2E_FAKE_AWS` needs Docker running: Floci has no macOS build, so it runs as
  the stack's own container (`E2E_FLOCI`), on `127.0.0.1:4586` (`E2E_AWS_PORT`)
  with the EC2 launch fake on `4587` (`E2E_EC2_PORT`), clear of 4566/4567,
  which LocalStack-style emulators usually hold.
- A unix socket path is at most 104 bytes, and `TMPDIR` is already about 50
  (`/var/folders/…/T/`). A box whose `boxes/<name>/tmux/sock` would not fit
  (a launched box with a long name) gets its tmux socket at
  `<root>/tmux/<checksum of the name>/sock` instead; `boxes/<name>/bin/tmux` points
  at whichever it is.
- Box panes run `/bin/bash` 3.2, with `BASH_SILENCE_DEPRECATION_WARNING=1` so
  they open without its zsh notice.
- `deploy/termag-hook-run` (the warm pool's units) needs GNU `timeout` on
  `PATH` (Homebrew's coreutils).

Some Linux-only tests (`/proc`, `ss`, `stat -c`) still assume Linux.

## The warm pool

`scripts/e2e/warm-pool.test.sh` (`make e2e-test-warm-pool`, also part of
`make e2e-test`) brings up its own stack with `E2E_WARM_POOL=2`, and drives the pool through the API and the boxes:

- the pool fills and warms through the on-warm unit;
- Add box hands back a claimed, `ready` box with the claimer's git identity,
  token and SSH keys;
- a claim right after a backend restart, before the pool's agents redial,
  takes the cold path and fails no warm box;
- claim-time dotfiles run, survive a socket reconnect, wait for GitHub login
  on a private repo, and settle when the claim hook reruns them.

The claim and dotfiles checks are skipped on a backend that does not claim
or a checkout without `deploy/termag-on-claim.service`, so the script passes
on any branch with the pool. `E2E_TEST_OLD_AGENT=<agent dir>` adds a check
against an agent from before claims reported their dotfiles status.

To click through it instead, start the stack with the warm-pool line at the
top of this page, sign in, and use **Add box**: with a warm box it comes back
`ready` at once, and the Boxes section shows the pool's depth. A dotfiles
repository set under **Agent** (try `https://github.com/e2e-org/dotfiles`,
with `E2E_DOTFILES_SCRIPTS=1` so its `install.sh` runs and takes its 3 s)
shows a personalizing badge on the next claim. `scripts/e2e/ctl.sh restart
box-network` drops every box's socket, and `ctl.sh restart backend` the
backend, to try what a claim does around either.

## The desktop bridge

`scripts/e2e/t3.test.sh` (`make e2e-test-t3`) brings up its own one-box stack
with `E2E_T3=1` on spare ports and checks the bridge the desktop app uses
: a device sign-in through
`/auth/cli/authorize` with curl as the browser (the PKCE flow the desktop runs),
`t3/ensure` until the box's t3 server answers (in the box's tmux session
`termag-t3`, on the port kept in `~/.termag/t3.json`), `t3/projects` with the
seeded project's real directory, `t3/pair`, the pairing exchange, the
descriptor, `/api/auth/session` and a WebSocket through the relay, a bad
ticket handed back as the box's 401, the refusals (no credential, a box's own
token, another box, an unknown tunnel id), and the server killed behind the
relay's back and started again by the next request, and (with
`E2E_FAKE_CLAUDE=1`) a thread's first Claude turn on the box through the relay
(`scripts/e2e/t3-turn.mjs`: a t3 project, `orchestration.launchThread` over
the relayed t3 WebSocket, the stand-in's answer in the projection), and what
termag records for such turns through the box's hooks: the project working,
then idle, from `t3:claude`; its working time and the box's idle clock; two
threads at once kept working until the last stops; a workstream's worktree
under that workstream; a folder no project owns under `termag-t3` only. Then
one t3 session per pairing label: a second `t3/pair` of a label leaves one
session (the newer), a pair revokes an unredeemed credential of its label, and
`t3/revoke` revokes the label's session and credential and no other label's
(counted with the box's own `t3 auth … list --json`).
`E2E_T3_COMMAND` points it at another t3 build.

`scripts/e2e/t3-slow-relay.test.sh` (`make e2e-test-t3-slow-relay`) runs six
downloads through the HTTP relay at once, each read slowly enough to take about
two minutes (`E2E_T3_SLOW_MB`, default 12 MiB, at `E2E_T3_SLOW_KBPS`, default
100 KiB/s). The box's t3 server is `scripts/e2e/fakes/t3-blob.mjs`, and the
reader is `scripts/e2e/slow-client.py` (python3), with a small fixed receive
buffer so the relay really is held back. Every download must arrive whole, in
order, and end, with no `[T3-RELAY]` line in the backend's log. This is the
case a backpressured tunnel's heartbeat, or an agent closing a tunnel before
its buffer drained, used to cut short and leave hanging.

`scripts/e2e/forward.test.sh` (`make e2e-test-forward`) is the native port
forward: the real `termag forward`
from `cli/`, the route with `E2E_FLAGS` turning `box-port-forward-enabled` on,
and the real box agent. `scripts/e2e/fakes/forward-stand-ins.cjs` serves the
box's ports on loopback as the test's own uid (an HTTP file, a WebSocket echo,
a half-close echo, a server that speaks first) and is also the laptop-side
client for each. It checks an HTTP GET, a 50 MiB download and six at once
(printing MB/s), the three protocols, the refusals (`port_refused` for a root
sshd on 22, `port_closed`, `bad_port`, `invalid_request`, a box's own token, a
local port already held), Ctrl-C's totals, 4409 when an `E2E_EC2_LAUNCH` box is
stopped mid-forward, `Instance.openTunnels` in the next host sample (up to five
minutes), the `[FORWARD]` log lines, and last the flag off (it rewrites
`backend.env` and restarts the backend, whose shutdown must log the close of the
forward it ends, 1001, and whose new in-memory signing key the CLI must refresh
past on its own): the CLI prints the `termag ssh … -N -L` fallback and exits. Through the busy wait run six downloads to slow readers
(`slow-client.py`) and three uploads to a slow service on the box
(`scripts/e2e/fakes/slow-sink.py`), each `E2E_FORWARD_SLOW_MB` (default 24 MiB)
at `E2E_FORWARD_SLOW_KBPS` (default 192 KiB/s), about two minutes, and each must
arrive whole: before the forward's own pings, the orchestrator's heartbeat cut
them 75 to 100 s in (`E2E_FORWARD_SLOW=0` skips them). `E2E_FORWARD_EXP=1`
holds a connection for 63 minutes, past its access token's `exp`. The 12 h cap (4408)
and the process ceiling can't be shortened in the stack; `cliForward.test.ts`
covers them.

`scripts/e2e/t3-newbox.test.sh` (`make e2e-test-t3-newbox`) is the desktop's
**New box…** flow, on its own ports and its own Floci container (in Docker on
macOS): `E2E_FAKE_AWS`, `E2E_EC2_LAUNCH`, `E2E_T3`, `E2E_FAKE_CLAUDE`,
`E2E_FAKE_GITHUB` and `E2E_CREDENTIAL_STORE`. It signs in as a device, stores a
GitHub token with `PUT /api/cli/v1/github` (encrypted with Floci's KMS key),
launches a box with `POST /api/cli/v1/boxes` and waits for it to be running with
its agent connected, ensures its t3 server, creates a project on it with
`POST /api/cli/v1/projects {boxId, name, agent: "claude-chat", from:
"https://github.com/e2e-org/sample"}` and follows its `clone` on `/projects`
and `t3/projects` (the stub holds the pack back 3 s): `waiting`, `cloning` with
`exists: false`, then `done`, the box's clone state file `ready`, the checkout
in place, the agent pane an idle shell and `t3/projects` listing it with
`exists: true`; a done clone refuses Retry. A project from a repository the
stub does not have ends `failed` with git's error, `retryable`, no directory
and no sessions; once the repository exists, `POST /projects/:id/clone/retry`
clones it. Then it pairs through the relay and opens its WebSocket, runs a
stand-in Claude turn in the checkout, tears the stack down and checks the root,
its processes and its container are gone.

To use the bridge by hand, `make e2e-up E2E_T3=1 BOXES=1` (add
`E2E_CLAUDE_BIN=$(command -v claude)` for a real Claude on the box) and point
the desktop app at `http://127.0.0.1:3040/termag`. With
`E2E_FAKE_AWS=1 E2E_EC2_LAUNCH=1 E2E_FAKE_GITHUB=1 E2E_CREDENTIAL_STORE=1` as
well it can launch boxes.

## Sign-in without an identity provider

`AUTH_MODE=local` makes `/auth/login` sign in as the first `ALLOWED_USERS`
identity. The backend refuses to start with it unless `NODE_ENV` is explicitly
`development` or `test` and `BIND_HOST` is `127.0.0.1` or `::1`. A loopback
bind alone does not keep callers on the same host, because a same-host reverse
proxy (the orchestrator's nginx gateway, Apache) makes every socket peer
loopback. So `/auth/login` also refuses, with a 403, any request whose
`X-Termag-Peer-Addr`, `X-Forwarded-For` or `Forwarded` header names an off-host
client. Production sets `NODE_ENV=production` (`deploy/termag.service`, the
`Dockerfile`) and never sets `BIND_HOST`. No other mode
has a sign-in bypass.

## What this does not cover

These still need a test in the Termag AWS account, and PRs should say so:

- AWS: box provisioning against real EC2 and IAM (`E2E_EC2_LAUNCH` runs
  `boxProvisioner`'s calls against Floci), cloud-init on the real AMI, real
  IAM, SSM, S3 and Bedrock. `E2E_FAKE_AWS` has the gaps listed above.
- Warm-pool flows (pool boxes, claiming, on-warm and on-claim steps).
- Okta and OIDC sign-in themselves, `HOST_AUTOSETUP`, and "this host" projects
  or MetaTerm on the orchestrator: the stack runs with `LOCAL_SESSIONS_ENABLED=false`,
  as the container does, so those paths fail fast.
- Slack and Discord.
- Several users. Every box runs as your unix user, and there is one signed-in
  identity (a second can be faked: "A second user" above).
