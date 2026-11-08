import { describe, expect, it } from 'vitest';
import { WORKFLOW_SCOPE_HINT, isWorkflowScopeRefusal, workflowScopeRefusal } from './workflowScope';

describe('isWorkflowScopeRefusal', () => {
  it("finds GitHub's refusal of an OAuth App or a token without the workflow scope", () => {
    expect(isWorkflowScopeRefusal(' ! [remote rejected] HEAD -> b (refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)\nerror: failed to push some refs')).toBe(true);
    expect(isWorkflowScopeRefusal(' ! [remote rejected] b -> b (refusing to allow a Personal Access Token to create or update workflow `.github/workflows/x.yml` without `workflow` scope)')).toBe(true);
  });

  it("finds the timeout refusal GitHub gives on a large repository", () => {
    expect(isWorkflowScopeRefusal(' ! [remote rejected] b -> b (Unable to determine if workflow can be created or updated due to timeout; `workflows` scope may be required)')).toBe(true);
  });

  it("picks GitHub's line out of git's output", () => {
    const out = 'To https://github.com/org/repo.git\n ! [remote rejected] HEAD -> b (refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)\nerror: failed to push some refs to \'https://github.com/org/repo.git\'';
    expect(workflowScopeRefusal(out)).toBe('! [remote rejected] HEAD -> b (refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)');
    expect(workflowScopeRefusal('error: failed to push some refs')).toBeNull();
  });

  it('ignores text that only quotes a refusal: docs, a log line, the pre-push advisory', () => {
    expect(isWorkflowScopeRefusal('refusing to allow an OAuth App to create or update workflow `.github/workflows/x.yml` without `workflow` scope')).toBe(false);
    expect(isWorkflowScopeRefusal('Unable to determine if workflow can be created or updated due to timeout; `workflows` scope may be required')).toBe(false);
    expect(isWorkflowScopeRefusal(WORKFLOW_SCOPE_HINT)).toBe(false);
  });

  it('ignores other refusals', () => {
    expect(isWorkflowScopeRefusal(' ! [rejected] b -> b (fetch first)')).toBe(false);
    expect(isWorkflowScopeRefusal('remote: error: GH013: Repository rule violations found')).toBe(false);
    expect(isWorkflowScopeRefusal('')).toBe(false);
  });

  it('names both ways out in one line', () => {
    expect(WORKFLOW_SCOPE_HINT).not.toContain('\n');
    expect(WORKFLOW_SCOPE_HINT).toContain('rebase onto the current origin/main');
    expect(WORKFLOW_SCOPE_HINT).toContain('`gh auth refresh -h github.com -s workflow`');
  });
});
