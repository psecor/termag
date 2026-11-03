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

## New UI in the simple UI: LaunchPad, and monospace only for code

- Build new simple-UI controls (`frontend/src/pages/chat/`, `frontend/src/chat/`) from LaunchPad,
  `@launchpad-ui/components`: buttons, icon buttons, menus, popovers, dialogs, tooltips, tabs, toggles,
  switches, fields and selects. Hand-roll a control only when LaunchPad has none, and say why in a
  comment. When you rework a hand-rolled control anyway, move it to LaunchPad's.
- Text is in the UI font, `var(--font-ui)`. `var(--font-mono)` is for code only: code blocks and inline
  code, paths, commands, keys and hashes, and terminal output. Never use it for labels, buttons, menus,
  headings or body copy.
- Read the gotcha "New simple-UI controls are LaunchPad's" in `docs/agents/gotchas.md` before adding a
  component. Its colours have to come from termag's theme, and its icons need LaunchPad's sprite.

## What AGENTS.md can't say about itself

An external agent-wiki sweeper rewrites `AGENTS.md` periodically. Three consequences: an unexplained
`M AGENTS.md` in `git status` is probably the sweeper rather than your edit; its rewrites have
previously reintroduced strings gitleaks blocks, so read that diff before committing
it; and a rewrite that pulls `docs/agents/` text back into `AGENTS.md` undoes the split, so keep
`AGENTS.md` an index and put the detail in `docs/agents/`. The sweeper's prompt holds only `AGENTS.md`,
the git log and agent-wiki's spec (which wants a numbered Gotchas list); it never reads `docs/agents/`
or this file. It rewrites whole section bodies, and only writes the file, with no commit (hence the
unexplained `M`). So a convention it must keep goes in the body of the `AGENTS.md` section it would
rewrite, backed by a test; nothing in `docs/agents/` steers it. Gotchas have no numbers: each has a slug, both lists are sorted by it, and a rule that
must survive a sweep has to be written in `AGENTS.md` itself (`docs/agents/gotchas.md` says how;
`backend/src/docsLists.test.ts` fails on a sweep that renumbers or reorders the index). Cite a gotcha
by subject or slug.

## Before your first commit here

Work in a fresh worktree per PR, created from `origin/main` under `.worktrees/` — never switch
branches inside a worktree another session may be using.

Run `pre-commit install`. The gitleaks hook blocks secrets in staged content — code, comments and docs alike.
