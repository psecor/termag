# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read AGENTS.md

`AGENTS.md` in this directory is the entry point to the maintained reference for this repo: what it
is, the layout, the architecture, build/run/test commands, and an index of everything else. The full
text it indexes is in `docs/agents/`: the domain model, data and schema, configuration,
observability, integration surfaces, and the gotchas (`AGENTS.md` lists each gotcha's one-line
rule; `docs/agents/gotchas.md` says why it holds). Neither is loaded into context automatically. Read
`AGENTS.md` before anything beyond a trivial edit, and the matching `docs/agents/` file (above all
the gotchas) before touching:

- **status handling** (Claude hooks, Codex bridge, tmux poller, working-time attribution) — the
  densest concentration of gotchas in the repo
- **agent providers** — the registry is duplicated in `backend/src/providers/registry.ts` and
  `frontend/src/providers/registry.ts` and must be kept in sync by hand
- **boxes / provisioning** — `services/boxProvisioner.ts`, `packer/`, `terraform/box/`
- **workstreams and tmux session naming**
- **`agent/agent.js`** — the per-user agent has no hot reload and must be restarted after every change

Deeper docs, all still current: `deploy/setup.md` (first-time setup), `deploy/claude-hooks.md`,
`docs/box-provisioning.md`, `docs/box-hibernation.md`, `docs/hosted-apps.md`,
`docs/container-deploy.md` (running the orchestrator as a container), `docs/e2e-stack.md` (a whole
termag on one machine, for exercising a change before a PR), `docs/stage.md` (a persistent staging
stack on a box, mirroring its per-user agent). Every feature flag is listed in `backend/src/flags.ts`.

## What AGENTS.md can't say about itself

An external agent-wiki sweeper rewrites `AGENTS.md` periodically. Three consequences: an unexplained
`M AGENTS.md` in `git status` is probably the sweeper rather than your edit; its rewrites have
previously reintroduced strings gitleaks blocks, so read that diff before committing it; and a rewrite that pulls `docs/agents/` text back into `AGENTS.md` undoes the split, so keep
`AGENTS.md` an index and put the detail in `docs/agents/`. Gotcha numbering shifts when it runs, so
cite gotchas by subject, not by number.

## Before your first commit here

Work in a fresh worktree per PR, created from `origin/main` under `.worktrees/` — never switch
branches inside a worktree another session may be using.

Run `pre-commit install`. The gitleaks hook blocks secrets in staged content — code, comments and docs alike.
