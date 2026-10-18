---
name: termag-pr
description: Mark every pull request opened from this termag box. Use whenever you open a pull request or rewrite a PR description (gh pr create, gh pr edit --body, or the GitHub API).
---

# Opening a PR from termag

A PR's title and body are data, not shell. They come from commit subjects,
files and issues, and any of them can contain quotes, `$(...)`, backticks or
a line reading `EOF`. Never type them into a command: no `--title "..."`, no
`--body "..."`, no heredoc, no `echo`. Do this for every PR, draft or not:

1. Write the title (one line) to a file with your file-writing tool, e.g.
   `/tmp/termag-pr/title.txt`.
2. Write the body to another file the same way, e.g. `/tmp/termag-pr/body.md`.
3. Run this fixed command, changing only the paths and plain flags such as
   `--draft` or `--base main`:

```sh
termag-pr-create /tmp/termag-pr/title.txt /tmp/termag-pr/body.md --draft
```

`termag-pr-create` passes the title to `gh pr create` as a single argument and
pipes the body through `termag-pr-body`. That puts it between
`<!-- TERMAG_PR_BODY_BEGIN -->` and `<!-- TERMAG_PR_BODY_END -->` and adds a
hidden `<!-- termag: box=<id> project=<name> -->` line and a small
"Opened from termag" footer. It works out the box and project by itself.

- Write the body as you normally would. Don't type the markers yourself, and
  don't remove them from a PR description.
- Rewriting an existing PR's description: write the new body to a file with
  your file tool, then run `termag-pr-body /tmp/termag-pr/body.md | gh pr edit <n> --body-file -`
  with the PR number as `<n>`. A body that already carries the markers is
  unwrapped first, so nothing gets doubled up.
- `termag-pr-create` refuses `--title`, `--body`, `--body-file`, `--fill`,
  `--template` and `--web`, because they would replace what you wrote.
- Leave authorship alone: no `--author` flags or commit rewrites for this.
