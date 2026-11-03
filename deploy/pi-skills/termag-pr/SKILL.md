---
name: termag-pr
description: Mark every pull request opened from this termag box. Use whenever you open a pull request or rewrite a PR description (gh pr create, gh pr edit --body, or the GitHub API).
---

# Opening a PR from termag

A PR's title and body are data, not shell. They come from commit subjects,
files and issues, and any of them can contain quotes, `$(...)`, backticks or
a line reading `EOF`. Never type them into a command: no `--title "..."`, no
`--body "..."`, no heredoc, no `echo`. Do this for every PR, draft or not:

1. Pick a directory of your own for the two files: your session's scratchpad
   directory if you have one, else make one with `mktemp -d`. Not a fixed
   path such as `/tmp/termag-pr/`: other sessions on the box write their
   drafts there too.
2. Write the title (one line) to a file there with your file-writing tool,
   e.g. `<dir>/title.txt`.
3. Write the body to another file the same way, e.g. `<dir>/body.md`.
4. Run this fixed command, changing only the paths (the directory's full
   path for `<dir>`) and plain flags such as `--draft` or `--base main`:

```sh
termag-pr-create <dir>/title.txt <dir>/body.md --draft
```

`termag-pr-create` passes the title to `gh pr create` as a single argument and
pipes the body through `termag-pr-body`. That puts it between
`<!-- TERMAG_PR_BODY_BEGIN -->` and `<!-- TERMAG_PR_BODY_END -->` and adds a
hidden `<!-- termag: box=<id> project=<name> -->` line and a small
"Opened from termag" footer. It works out the box and project by itself.

- Write the body as you normally would. Don't type the markers yourself, and
  don't remove them from a PR description.
- Rewriting an existing PR's description: write the new body to a file in
  your own directory with your file tool, then run
  `termag-pr-body <dir>/body.md | gh pr edit <n> --body-file -` with the PR
  number as `<n>`. A body that already carries the markers is
  unwrapped first, so nothing gets doubled up.
- `termag-pr-create` refuses `--title`, `--body`, `--body-file`, `--fill`,
  `--template` and `--web`, because they would replace what you wrote.
- In a `termag ask` run (`TERMAG_ASK_THREAD` is set): open the PR as a
  draft, and end the body with who asked and how to follow up, e.g. "Asked by
  `<username>` through `termag ask`; follow up with `termag ask … --thread
  <TERMAG_ASK_THREAD>`". `termag-pr-body` adds the thread to the hidden
  marker by itself. When the change spans several PRs, link each from the
  others' bodies.
- Leave authorship alone: no `--author` flags or commit rewrites for this.
- Before you open a new PR, check the files and flags it changes with
  `termag-overlap`, as the `termag-overlap` skill says. Tell the user about any
  open PR or recent commit that already does the same before you open yours.
