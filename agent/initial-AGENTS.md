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

## Gotchas

1. **<Short bold lede>** — <one to three sentences. Be specific
   enough that an agent encountering the situation can recognize it.>

2. **<...>** — <...>

## Related

**Other projects:**
- _none yet_

**Topics:**
- _none yet_

<!-- agent-wiki:backlinks-start -->
_No incoming links yet._
<!-- agent-wiki:backlinks-end -->
