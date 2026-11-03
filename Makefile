# Local end-to-end stack (docs/e2e-stack.md). BOXES=N sets the box count; the
# opt-in fakes are E2E_* variables, e.g. `make e2e-up E2E_FAKE_AWS=1`.
.PHONY: e2e-up e2e-down e2e-status e2e-ctl e2e-test e2e-test-warm-pool e2e-test-cli e2e-test-cli-connect e2e-test-cli-doctor e2e-test-spaces e2e-test-genui install-cli install-tui e2e-test-box-teardown e2e-test-overlap e2e-test-ask-overlap e2e-test-ask-box e2e-test-isolation e2e-test-multi-repo e2e-test-multi-repo-rename e2e-test-multi-repo-prs e2e-test-multi-repo-pr-checkout e2e-test-t3 e2e-test-t3-newbox e2e-test-t3-slow-relay e2e-test-forward

# Build cli/ and put `termag` on PATH (cli/README.md). Re-run after `git pull`
# to update. BIN_DIR=<dir> overrides where the launcher goes.
install-cli:
	@sh cli/install.sh $(if $(BIN_DIR),--bin-dir "$(BIN_DIR)")

# Build tui/ for `termag tui` (Node 22+). Separate from install-cli; re-run after
# `git pull` to rebuild.
install-tui:
	@sh tui/install.sh

e2e-up:
	@E2E_BOXES=$(or $(BOXES),$(E2E_BOXES),2) bash scripts/e2e/up.sh

e2e-down:
	@bash scripts/e2e/down.sh

e2e-status:
	@bash scripts/e2e/status.sh

# make e2e-ctl ARGS="restart box-1" | ARGS="fault box-1 hang"
e2e-ctl:
	@bash scripts/e2e/ctl.sh $(ARGS)

e2e-test:
	@sh scripts/e2e/lib.test.sh && bash scripts/e2e/fakes/git-credential-host.test.sh && bash scripts/e2e/e2e.test.sh && bash scripts/e2e/fakes.test.sh && bash scripts/e2e/warm-pool.test.sh && bash scripts/e2e/box-teardown.test.sh && bash scripts/e2e/cli.test.sh && bash scripts/e2e/cli-connect.test.sh && bash scripts/e2e/overlap.test.sh && bash scripts/e2e/ask-overlap.test.sh && bash scripts/e2e/ask-box.test.sh && bash scripts/e2e/isolation.test.sh && bash scripts/e2e/multi-repo.test.sh && bash scripts/e2e/multi-repo-rename.test.sh && bash scripts/e2e/multi-repo-prs.test.sh && bash scripts/e2e/multi-repo-pr-checkout.test.sh

e2e-test-warm-pool:
	@bash scripts/e2e/warm-pool.test.sh

# The desktop app's box bridge; downloads the
# pinned t3 release once into ~/.cache/termag-e2e. E2E_T3_COMMAND=<cmd> tests another build.
e2e-test-t3:
	@bash scripts/e2e/t3.test.sh

# The bridge's HTTP relay under six slow clients at once, each for about two
# minutes: every download must arrive whole and end (python3 for the client).
e2e-test-t3-slow-relay:
	@bash scripts/e2e/t3-slow-relay.test.sh

# The native port forward: `termag forward` against the
# real route and box agent, with stand-in services on the box, slow readers and
# a slow service among them. E2E_FORWARD_EXP=1 holds a connection past its
# access token's exp (about 65 minutes).
e2e-test-forward:
	@bash scripts/e2e/forward.test.sh

# The desktop app's "New box…" flow: launch a box, a project on it from a
# GitHub repo, its t3 server, a thread through the relay. Needs Floci:
# native on Linux, Docker on macOS.
e2e-test-t3-newbox:
	@bash scripts/e2e/t3-newbox.test.sh

e2e-test-cli-doctor:
	@bash scripts/e2e/cli-doctor.test.sh

e2e-test-box-teardown:
	@bash scripts/e2e/box-teardown.test.sh

e2e-test-overlap:
	@bash scripts/e2e/overlap.test.sh

e2e-test-ask-overlap:
	@bash scripts/e2e/ask-overlap.test.sh

e2e-test-ask-box:
	@bash scripts/e2e/ask-box.test.sh

e2e-test-isolation:
	@bash scripts/e2e/isolation.test.sh

e2e-test-multi-repo:
	@bash scripts/e2e/multi-repo.test.sh

e2e-test-multi-repo-rename:
	@bash scripts/e2e/multi-repo-rename.test.sh

# A multi-repo workstream's PR lanes, Review pane and spawn retire. Needs Floci
# (the credential store holds the stub GitHub token): native on Linux, Docker on macOS.
e2e-test-multi-repo-prs:
	@bash scripts/e2e/multi-repo-prs.test.sh

# A pull request checked out into a multi-repo project. Needs Floci, as above.
e2e-test-multi-repo-pr-checkout:
	@bash scripts/e2e/multi-repo-pr-checkout.test.sh

e2e-test-cli:
	@bash scripts/e2e/cli.test.sh

e2e-test-cli-connect:
	@bash scripts/e2e/cli-connect.test.sh

e2e-test-spaces:
	@bash scripts/e2e/spaces.test.sh

e2e-test-genui:
	@bash scripts/e2e/genui.test.sh

# Persistent staging on this box, mirroring the per-user agent that already
# runs here (docs/stage.md). `make stage-sync BRANCHES="a b"` resets the
# checkout to origin/main, merges those branches and restarts.
.PHONY: stage-up stage-down stage-status stage-sync stage-add stage-restart stage-logs
stage-up:
	@bash scripts/stage/stage.sh up
stage-down:
	@bash scripts/stage/stage.sh down
stage-status:
	@bash scripts/stage/stage.sh status
stage-sync:
	@bash scripts/stage/stage.sh sync $(BRANCHES)
stage-add:
	@bash scripts/stage/stage.sh add $(BRANCHES)
stage-restart:
	@bash scripts/stage/stage.sh restart $(UNITS)
stage-logs:
	@bash scripts/stage/stage.sh logs $(UNIT) $(ARGS)

# The desktop app's dev loop, against the fork checked
# out beside this one (TERMAG_DESKTOP_DIR overrides). desktop-poc builds the
# app, brings up the local stack with t3 boxes, and launches the app pointed at
# it. ARGS="--real-claude" | "--smoke" | "--no-build" | "--no-app" | "--new-boxes"
# (launch boxes and clone repos onto them; Floci runs in Docker on macOS).
.PHONY: desktop-poc
desktop-poc:
	@bash scripts/desktop-poc/up.sh $(ARGS)

# The app with hot reload, and the stack (started if it isn't up) restarting
# its orchestrator and box t3 servers on source changes. Stop it any time; the
# stack stays up (make e2e-down stops it).
.PHONY: desktop-dev
desktop-dev:
	@bash scripts/desktop-poc/up.sh --dev $(ARGS)

# The same two halves as two long-running commands: the stack from this
# checkout, until stopped, and the app in dev mode from a fork checkout
# (ARGS="--fork <x>").
.PHONY: desktop-host desktop-app
desktop-host:
	@bash scripts/desktop-poc/host.sh $(ARGS)
desktop-app:
	@bash scripts/desktop-poc/app.sh $(ARGS)
