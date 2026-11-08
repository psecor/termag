'use strict';

// GitHub's refusal of a push for want of the `workflow` scope, and the line
// termag adds when it sees one: the agent's copy of
// backend/src/services/workflowScope.ts ("Scopes the
// stored token needs"), kept to the same patterns and wording. The stored
// token needs only `repo` and `read:org`. Without `workflow`, GitHub refuses
// any push whose commits change `.github/workflows` compared with its copy,
// which a branch based on a different main than GitHub's does.

// "refusing to allow an OAuth App (or a Personal Access Token) to create or
// update workflow … without `workflow` scope", and, on a large repository,
// "Unable to determine if workflow can be created or updated due to timeout;
// `workflows` scope may be required". Only as git prints a refused ref,
// `! [remote rejected] <src> -> <dst> (<GitHub's reason>)`: text that merely
// quotes them (docs, a log, the pre-push hook's advisory) is not a refusal.
const REFUSALS = [
  /\[remote rejected\][^\n(]*\(refusing to allow an? [^\n)]{1,40}? to create or update workflow/i,
  /\[remote rejected\][^\n(]*\(Unable to determine if workflow can be created or updated due to timeout/i,
];

const WORKFLOW_SCOPE_HINT =
  'termag: this push changes workflow files compared with GitHub\'s copy, and the stored GitHub token has no `workflow` scope. ' +
  'Usually this means the branch is based on a different main than GitHub\'s: rebase onto the current origin/main and push again. ' +
  'Or, to allow workflow edits, run `gh auth refresh -h github.com -s workflow` and paste `gh auth token` into Settings → GitHub again.';

/** Whether text holds GitHub's refusal for want of the `workflow` scope. */
function isWorkflowScopeRefusal(text) {
  return typeof text === 'string' && REFUSALS.some(re => re.test(text));
}

module.exports = { WORKFLOW_SCOPE_HINT, isWorkflowScopeRefusal };
