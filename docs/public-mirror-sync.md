# Public mirror sync: scrub + cherry-pick recipe

This repo has two git remotes with **deliberately divergent histories**:

| Remote | URL | Role |
|---|---|---|
| `labs` (canonical) | `git@github.com:launchdarkly-labs/termag.git` | The internal mirror. LD-specific content (`o11y-termag` IAM grant, internal AWS account refs, `ALLOWED_USERS` examples, personal hostnames) is allowed here. |
| `origin` (public) | `git@github-psecor:psecor/termag.git` | The scrubbed public mirror. No `launchdarkly` mentions, no internal module names, no personal hostnames, no internal contributor work emails. |

Local `main` tracks `labs/main`. The plain `git push` flow ships to labs. The public mirror is refreshed in batches by cherry-picking + scrubbing + author-rewriting + pushing.

## Why divergent

The histories forked at `86cb06e chore: scrub LD-specific and personal-host references for public mirror` (the original 2026-05 scrub). The 4 commits prior to it on origin have identical messages but different SHAs from their labs counterparts. **Never force-push labs → origin** — it would overwrite the scrubbed history with the un-scrubbed one, leaking everything the scrub was meant to remove.

## What the public mirror must not contain

The `.gitleaks.toml` deny-list is the canonical reference. As of this writing:

- `(?i)launchdarkly` — name / domain / GitHub org references (catches `launchdarkly.com`, `launchdarkly-labs`, `github.com/launchdarkly/`, bare "LaunchDarkly" mentions)
- `(?i)secorp\.net` — personal host name used for orchestrator deploy
- `(?i)(vkorolik|vadman97)` — internal collaborator handle fragments
- `(?i)o11y-(devbox|termag)` — internal terraform module names

`LICENSE` and `.gitleaks.toml` itself are allowlisted (the LICENSE has a legitimate copyright line; the gitleaks rules name the strings they're looking for).

The pre-commit hook (`.pre-commit-config.yaml`) wires `gitleaks` so any commit attempting to add these strings is blocked before it lands. The hook scans staged file content, not commit messages — see "Author rewrite" for the message-side trade-off.

## Sync recipe

When labs has new commits to port, work on a temp branch off `origin/main`:

```bash
git fetch origin labs
git switch -c port-from-labs origin/main
```

For each labs commit to port:

```bash
git cherry-pick <labs-sha>
# Resolve any conflicts (often the scrubbed origin/main differs from labs/main
# in the same comment-region the new commit edits — keep the scrubbed text, add
# the new functional content)

# If the cherry-picked commit's content needs further scrubbing, edit in-place
# and `git commit --amend`, or use `git cherry-pick --no-commit` and clean up
# before committing.
```

Cherry-picks that bring in skipped-on-purpose content (e.g. an LD-internal CI workflow file) should be done with `--no-commit`, the offending files removed, and then committed. Commits that are **entirely** LD-only (e.g. publish-AMI workflows targeting the `launchdarkly-labs` OIDC audience) should be skipped outright.

### Author rewrite

After all cherry-picks land, rewrite authors to a generic public identity. The rebase walks each commit and amends:

```bash
cat > /tmp/rewrite-author.sh <<'BASH'
#!/bin/bash
set -e
msg=$(git log -1 --format=%B)
GIT_COMMITTER_DATE=$(git log -1 --format=%cI) \
  git commit --amend \
    --author="secorp <secorp@gmail.com>" \
    --message="$msg" \
    --no-verify >/dev/null
BASH
chmod +x /tmp/rewrite-author.sh

git rebase origin/main --exec /tmp/rewrite-author.sh
```

(`--no-verify` here skips the pre-commit gitleaks run on the amend — the content didn't change, only metadata, so the prior pre-commit pass still applies.)

#### Author mapping

| Original | Rewritten to | Trailer added |
|---|---|---|
| Peter Secor `<psecor@launchdarkly.com>` | `secorp <secorp@gmail.com>` | none |
| Vadim Korolik `<vkorolik@gmail.com>` | `secorp <secorp@gmail.com>` | `Co-Authored-By: Vadim Korolik <vkorolik@launchdarkly.com>` |
| Ramon Niebla `<rniebla@ip-*.ec2.internal>` | `secorp <secorp@gmail.com>` | `Co-Authored-By: Ramon Niebla <rniebla@launchdarkly.com>` |

Per-author Co-Authored-By trailers are added during the rebase script (extend the script to look at the original author email and append the appropriate trailer if not already present).

**Known trade-off:** Co-Authored-By trailers with LD work emails put `launchdarkly.com` strings into commit message bodies on origin. The pre-commit gitleaks hook only scans staged file diffs (not commit messages), so it passes — but a full `gitleaks detect` against the repo would flag them. This is an accepted exception so contributions stay attributed to their authors. Don't extend gitleaks to scan messages without adding an allowlist for `Co-Authored-By:.*launchdarkly\.com` first.

### Push

```bash
git push origin port-from-labs:main
git switch main
git branch -D port-from-labs
```

Fast-forward only — `origin/main` should always be reachable from the post-rebase branch tip.

## Reverse direction (origin → labs)

Public-first commits (rare, but they happen — e.g. a contributor PR against `psecor/termag` accepted directly on the public side) can be back-ported the other way:

```bash
git switch main      # tracks labs/main
git cherry-pick <origin-sha>
git push labs main
```

No scrub needed in this direction — LD is fine with the `secorp@gmail.com` author and any public content. Example: `4f88354 frontend: ?narrow=N URL param` was committed directly to origin, then back-ported to labs.

## Common gotchas

1. **Sweeper auto-edits to AGENTS.md leak.** The agent-wiki sweeper periodically rewrites `AGENTS.md` with phrasing that includes `o11y-termag` etc. If the working tree shows an `M AGENTS.md` modification, scrub it before committing.
2. **Frontend `dist/` survives branch switches.** The built bundle in `frontend/dist/` is keyed to whichever branch's source it was last built from. Switching from `main` to `port-from-labs` (or vice versa) without rebuilding leaves the running backend serving a stale UI. Run `npm run build` in `frontend/` after big branch switches, or just stop the backend.
3. **PR-merge commits on labs make the "what's not on origin" comparison noisy.** `git log labs/main --not origin/main` compares by SHA, so it lists everything that diverged. Use commit *messages* to find truly un-ported work: `git log labs/main --oneline` and `git log origin/main --oneline`, then diff by message.
4. **Per-PR labs commits sometimes land out of order with your cherry-pick batch.** A PR merged on labs the same day you're doing a port can be invisible in the listing you started from. Re-check `git fetch labs && git log` before pushing the final origin batch.
5. **`Co-Authored-By` trailers don't carry through `git commit --amend` automatically.** If you amend a commit and the trailer was set by an external tool (e.g. another agent or `gh`), it survives because it's part of the message — but if you `commit -m "$NEW_MSG"` you have to include the trailer manually.

## When to refresh

- Whenever labs accumulates a handful of commits worth showing publicly.
- Right before a public release / announcement, so the mirror lines up with whatever's getting shared.
- After a significant scrub-pattern change to `.gitleaks.toml` (so the rule's deny-list reflects the current state of both mirrors).

There's no strict cadence. Periodic batches are fine; in practice this gets done when there's a meaningful chunk of new work or someone asks "is the public version current?".
