---
project: <slug>
status: in-progress
status_description: "<one sentence: what's stable, what's not, where deployed if anywhere>"
last_updated: YYYY-MM-DD
last_updated_by:
  - human:<handle>
wiki_schema_version: 1
---

# AGENTS.md — <project name>

## What This Is

<One paragraph. What it does, who it's for, what problem it solves.
If there's a public URL, name it here.>

## Status

<One paragraph or a short list. What's implemented, what isn't.
Lets a reader calibrate trust before reading further.>

## Domain Model

<Optional. Include only if the domain has non-obvious concepts that
the rest of the doc would be confusing without. Otherwise delete
this section entirely.>

## Repository Layout

```
<project>/
├── ...                        <annotation>
└── ...
```

## Architecture

<How the pieces fit. ASCII diagram if request/data flow matters.
Call out trade-offs explicitly:>

**Trade-off:** <what we chose> / <what we gave up> / <why>

## Data & Schema

<Skip if no persistent data. Otherwise: table of models, key fields,
notable constraints. Include schema-change conventions.>

| Model | Purpose |
|-------|---------|
| ...   | ...     |

## Configuration

<Env vars and other runtime config, grouped by service. Note which
are secrets (no values), public, or differ between dev and prod.>

## Build, Run, Deploy

```bash
# build
...

# deploy
...
```

## Observability & Maintenance

<Where logs live, how to tail them, how to check service health,
common operational tasks.>

## Integration Surfaces

<Optional. APIs, webhooks, real-time events, anything other projects
consume. Tabular: event/endpoint, payload shape, when emitted.>

## Sharing files

On a termag box, read the `termag-spaces` skill (`~/.claude/skills/termag-spaces/SKILL.md`) before sharing
a file with a person, saving a plan that should outlive the session, or handing files to another agent or box.

## Gotchas

1. **<Short bold lede>** — <one to three sentences. Be specific
   enough that an agent encountering the situation can recognize it.>

2. **<...>** — <...>

## Delegating work

On a termag box, `termag ask <box>/<project>` runs a headless Claude Code turn on a clone
of one of your own projects' pushed code, with your access, network and tools on its box (no
sandbox), and hands back its reply and a draft PR. Run it on a new box
(`termag project create … --new-box --from …`) unless the ask is small and mostly reads
code; a `--thread` follow-up goes to the box and project its thread started on. Read the
`agent-ask` skill (`~/.claude/skills/agent-ask/SKILL.md`) before spinning up a subagent or
delegating work.

## Related

**Other projects:**
- _none yet_

**Topics:**
- _none yet_

<!-- agent-wiki:backlinks-start -->
_No incoming links yet._
<!-- agent-wiki:backlinks-end -->
