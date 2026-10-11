import { describe, expect, it } from 'vitest';
import { boxRenameError, boxRenameRpcError, renameSessionPairs } from './projectRename';

describe('renameSessionPairs', () => {
  it('renames every session of every workflow, workstreams and the review pane included', () => {
    expect(renameSessionPairs('alice', 'old', 'new', [
      { type: 'agent', workstream: 'main' },
      { type: 'data', workstream: 'main' },
      { type: 'agent', workstream: 'feature' },
    ])).toEqual([
      { from: 'alice-old-agent', to: 'alice-new-agent' },
      { from: 'alice-old-ctrl', to: 'alice-new-ctrl' },
      { from: 'alice-old-review', to: 'alice-new-review' },
      { from: 'alice-old-data', to: 'alice-new-data' },
      { from: 'alice-old-data-ctrl', to: 'alice-new-data-ctrl' },
      { from: 'alice-old-feature-agent', to: 'alice-new-feature-agent' },
      { from: 'alice-old-feature-ctrl', to: 'alice-new-feature-ctrl' },
      { from: 'alice-old-feature-review', to: 'alice-new-feature-review' },
    ]);
  });
});

describe('boxRenameError', () => {
  // Regression: a box project's rename used to run tmux and mv on the
  // orchestrator, leaving the box's sessions and directory under the old name.
  it('refuses a box project whose agent is not connected', () => {
    expect(boxRenameError('ready', false)).toEqual({ status: 503, body: { error: 'Box agent is not connected' } });
  });

  it('says so when the box is powered down', () => {
    expect(boxRenameError('stopped', false)).toMatchObject({ status: 409, body: { error: expect.stringContaining('stopped') } });
  });

  it('lets a connected box rename', () => {
    expect(boxRenameError('ready', true)).toBeNull();
  });
});

describe('boxRenameRpcError', () => {
  it('explains an agent that predates the RPC', () => {
    expect(boxRenameRpcError('Unknown command: project-rename'))
      .toMatchObject({ status: 409, body: { code: 'agent_outdated' } });
  });

  it('passes any other failure on', () => {
    expect(boxRenameRpcError('/home/a/projects/new already exists'))
      .toEqual({ status: 502, body: { error: 'The box could not rename the project: /home/a/projects/new already exists' } });
  });
});
