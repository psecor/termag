/**
 * GitHub's refusal of a push for want of the `workflow` scope, and the line
 * termag adds wherever it sees one ("Scopes the stored
 * token needs").
 *
 * The stored token needs only `repo` and `read:org`; `workflow` is optional.
 * GitHub checks it on every push whose commits change a file under
 * `.github/workflows` compared with what GitHub has, so a token without it
 * is refused for a branch that never edited a workflow but is based on a
 * different main than GitHub's. The broker only authorizes requests and
 * never sees GitHub's answer, so the line goes in where termag reads git's
 * output: ask publish (askPublish.ts), the ask reply (agent/ask-chat.js) and
 * an ask clone's pre-push hook (deploy/termag-subagent-run). Those copies
 * keep the same patterns and wording.
 */

/**
 * GitHub's two refusals: "refusing to allow an OAuth App (or a Personal
 * Access Token) to create or update workflow … without
 * `workflow` scope", and, on a large repository, "Unable to determine if
 * workflow can be created or updated due to timeout; `workflows` scope may
 * be required". Only as git prints a refused ref, `! [remote rejected] <src>
 * -> <dst> (<GitHub's reason>)`: text that merely quotes them (docs, a log,
 * the pre-push hook's advisory) is not a refusal.
 */
const REFUSALS = [
  /\[remote rejected\][^\n(]*\(refusing to allow an? [^\n)]{1,40}? to create or update workflow/i,
  /\[remote rejected\][^\n(]*\(Unable to determine if workflow can be created or updated due to timeout/i,
];

export const WORKFLOW_SCOPE_HINT =
  'termag: this push changes workflow files compared with GitHub\'s copy, and the stored GitHub token has no `workflow` scope. ' +
  'Usually this means the branch is based on a different main than GitHub\'s: rebase onto the current origin/main and push again. ' +
  'Or, to allow workflow edits, run `gh auth refresh -h github.com -s workflow` and paste `gh auth token` into Settings → GitHub again.';

/** The line of git's output with GitHub's refusal for want of the `workflow` scope, trimmed; null without one. */
export function workflowScopeRefusal(output: string): string | null {
  return output.split('\n').map(l => l.trim()).find(l => REFUSALS.some(re => re.test(l))) ?? null;
}

/** Whether git's output holds GitHub's refusal for want of the `workflow` scope. */
export function isWorkflowScopeRefusal(output: string): boolean {
  return workflowScopeRefusal(output) !== null;
}
