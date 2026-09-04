# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read AGENTS.md

`AGENTS.md` in this directory is the maintained reference for this repo: architecture, domain model,
schema, integration surfaces, build/run/test commands, and a numbered gotcha list. It is not loaded
into context automatically. Read it before anything beyond a trivial edit — and always before
touching:

- **status handling** (Claude hooks, Codex bridge, tmux poller, working-time attribution) — the
  densest concentration of gotchas in the repo
- **agent providers** — the registry is duplicated in `backend/src/providers/registry.ts` and
  `frontend/src/providers/registry.ts` and must be kept in sync by hand
- **boxes / provisioning** — `services/boxProvisioner.ts`, `packer/`, `terraform/box/`
- **workstreams and tmux session naming**
- **`agent/agent.js`** — the per-user agent has no hot reload and must be restarted after every change

Deeper docs, all still current: `deploy/setup.md` (first-time setup), `deploy/claude-hooks.md`,
`docs/box-provisioning.md`, `docs/hosted-apps.md`, `docs/container-deploy.md` (running the
orchestrator as a container), `docs/public-mirror-sync.md`.

## What AGENTS.md can't say about itself

An external agent-wiki sweeper rewrites `AGENTS.md` periodically. Two consequences: an unexplained
`M AGENTS.md` in `git status` is probably the sweeper rather than your edit, and its rewrites have
previously reintroduced strings the gitleaks deny-list blocks — read that diff before committing it.
Gotcha numbering shifts when it runs, so cite gotchas by subject, not by number.

## Before your first commit here

Run `pre-commit install`. The gitleaks hook blocks the `.gitleaks.toml` deny-list (the LD domain, a
personal orchestrator hostname, internal collaborator handles) in staged content — code, comments and
docs alike.

This project is mirrored to a scrubbed public repo whose history deliberately diverges from the
internal one — and the remote *names* differ between clones (some have `labs` + `origin`, some just
`origin`). Run `git remote -v` and confirm which repo you're pushing to before you push. **Never
force-push the internal history over the public mirror**; it would overwrite the scrub. Recipe and
rationale: `docs/public-mirror-sync.md`.
