# Local end-to-end stack (docs/e2e-stack.md). BOXES=N sets the box count; the
# opt-in fakes are E2E_* variables, e.g. `make e2e-up E2E_FAKE_AWS=1`.
.PHONY: e2e-up e2e-down e2e-status e2e-ctl e2e-test e2e-test-warm-pool e2e-test-cli e2e-test-cli-connect e2e-test-cli-doctor e2e-test-spaces install-cli install-tui e2e-test-box-teardown e2e-test-overlap e2e-test-ask-overlap e2e-test-ask-box

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
	@sh scripts/e2e/lib.test.sh && bash scripts/e2e/e2e.test.sh && bash scripts/e2e/fakes.test.sh && bash scripts/e2e/warm-pool.test.sh && bash scripts/e2e/box-teardown.test.sh && bash scripts/e2e/cli.test.sh && bash scripts/e2e/cli-connect.test.sh && bash scripts/e2e/overlap.test.sh && bash scripts/e2e/ask-overlap.test.sh && bash scripts/e2e/ask-box.test.sh

e2e-test-warm-pool:
	@bash scripts/e2e/warm-pool.test.sh

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

e2e-test-cli:
	@bash scripts/e2e/cli.test.sh

e2e-test-cli-connect:
	@bash scripts/e2e/cli-connect.test.sh

e2e-test-spaces:
	@bash scripts/e2e/spaces.test.sh

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
