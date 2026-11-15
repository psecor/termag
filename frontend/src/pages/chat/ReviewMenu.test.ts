import { describe, expect, it, vi } from 'vitest';
import type { PrGroupMember, PrReviewGroup } from '../../services/api';
import { groupReviewPlan } from '../../utils/prReviewGroups';
import { REVIEW_CHAT_ENGINES, REVIEW_CHAT_PROVIDERS, reviewChatOnBoxes, chatPlaces, copyOfAt, reviewChatMembers, reviewChatsHere, reviewChatWhere, clearStarting, markStarting, noRunReason, noteStartingBefore, openPlan, reviewChatPrompt, reviewSessionPrompt, runReviewStart, startingFor } from './ReviewMenu';

const pane = { projectId: 'p', projectName: 'termag', workstream: 'termag-pr1' };
const member = (number: number, state: PrGroupMember['state'], extra: Partial<PrGroupMember> = {}): PrGroupMember => ({
  repo: 'example-org/termag', number, note: null, title: `PR ${number}`, url: '', author: 'e2e-fabian', state,
  yourReview: null, askedYou: true, checked: false, row: null, inLane: true, ...extra,
} as PrGroupMember);
const group = (members: PrGroupMember[]): PrReviewGroup => ({ id: 'g', name: 'Port forward', closedAt: null, createdAt: '', done: false, members } as PrReviewGroup);

describe('Review all together', () => {
  it("reviews only the open members, from a closed member's checkout when it's the only one", () => {
    const plan = openPlan(groupReviewPlan(group([member(1, 'merged', { pane }), member(2, 'open'), member(3, 'closed')]), 'e2e-octocat'));
    expect(plan).toEqual({ members: [expect.objectContaining({ number: 2 })], target: pane });
  });

  it('says nothing is left once only closed members are', () => {
    expect(openPlan(groupReviewPlan(group([member(1, 'merged', { pane }), member(3, 'closed')]), 'e2e-octocat'))).toEqual({ reason: 'Nothing left to review in this group' });
  });
});

describe('a Review button with nowhere to run', () => {
  it('says why under it: no project, and with cloning on, no box either', () => {
    expect(noRunReason('example-org/terraform', false)).toBe('No project on terraform yet. Start a New session on example-org/terraform, and Review runs there.');
    expect(noRunReason('example-org/terraform', true))
      .toBe('No project on terraform, and no box to clone it on. Start a New session on example-org/terraform (it can make a box too), and Review runs there.');
    expect(noRunReason(undefined, true)).toBe('Nowhere to run it');
    expect(noRunReason('example-org/terraform', true, true))
      .toBe("No project on terraform, and your boxes couldn't be read to clone it onto. Reload the page to try again.");
    expect(noRunReason('example-org/terraform', false, false, true))
      .toBe("Your projects couldn't be read to find one on terraform. Reload the page to try again.");
  });
});

describe('a review started in its session', () => {
  const at = { projectId: 'p20', workstream: 'main' };
  const begin = (id = 's1') => markStarting(at.projectId, at.workstream, { reviewer: 'Devin', repo: 'example-org/termag', number: 1, at: 0, before: [], pending: true, step: 'Starting the review…', id });
  const deps = (held: Array<{ state: 'waking' | 'starting' | 'failed'; box: string; error?: string; since?: number } | null>) => {
    const seq = [...held];
    const steps: Array<string | undefined> = [];
    return {
      steps,
      readHeld: vi.fn(async () => { const h = seq.length > 1 ? seq.shift()! : seq[0]; return h; }),
      sleep: async () => { steps.push(startingFor(at.projectId, at.workstream)?.step); },
      now: () => 42,
    };
  };

  it('starts at once when the box is up, and the wait for its pane begins', async () => {
    begin();
    const d = deps([null]);
    await runReviewStart(at, 's1', async () => ({}), d);
    expect(d.readHeld).not.toHaveBeenCalled();
    expect(startingFor(at.projectId, at.workstream)).toMatchObject({ pending: false, step: undefined, at: 42 });
  });

  it('follows a start the route holds while its box wakes, step by step', async () => {
    begin();
    const d = deps([{ state: 'waking', box: 'termag-20', since: 1000 }, { state: 'starting', box: 'termag-20', since: 1000 }, null]);
    await runReviewStart(at, 's1', async () => ({ held: true, box: 'termag-20' }), d);
    expect(d.steps).toEqual(['Waking termag-20…', 'Waking termag-20…', 'Starting the review…']);
    expect(startingFor(at.projectId, at.workstream)?.heldSince).toBe(1000);
    expect(startingFor(at.projectId, at.workstream)).toMatchObject({ pending: false, step: undefined });
    expect(startingFor(at.projectId, at.workstream)?.error).toBeUndefined();
  });

  it('shows what to do in the session when the held start fails', async () => {
    begin();
    const d = deps([{ state: 'failed', box: 'termag-20', error: 'termag-20 took too long to wake. Start termag-20 from your boxes, then Review again.' }]);
    await runReviewStart(at, 's1', async () => ({ held: true, box: 'termag-20' }), d);
    expect(startingFor(at.projectId, at.workstream)).toMatchObject({
      pending: false, error: 'termag-20 took too long to wake. Start termag-20 from your boxes, then Review again.',
    });
  });

  it('shows the start\'s refusal in the session', async () => {
    begin();
    const refused = { response: { status: 409, data: { error: 'termag-20 is stopped, and only its owner can start it. Ask them to, then Review again.' } } };
    await runReviewStart(at, 's1', async () => { throw refused; }, deps([null]));
    expect(startingFor(at.projectId, at.workstream)).toMatchObject({
      pending: false, error: 'termag-20 is stopped, and only its owner can start it. Ask them to, then Review again.',
    });
  });

  it('leaves a later start\'s entry alone', async () => {
    begin('s1');
    const d = deps([{ state: 'failed', box: 'termag-20', error: 'late failure' }]);
    // A second Review replaced the entry while the first followed its held start.
    d.sleep = async () => { begin('s2'); };
    await runReviewStart(at, 's1', async () => ({ held: true, box: 'termag-20' }), d);
    expect(startingFor(at.projectId, at.workstream)).toMatchObject({ id: 's2', pending: true, step: 'Starting the review…' });
    expect(startingFor(at.projectId, at.workstream)?.error).toBeUndefined();
  });

  it('keeps a pane listed while the start is pending with the earlier ones, and none once it answered', () => {
    begin('s3');
    noteStartingBefore(at.projectId, at.workstream, '2026-11-06T17:00:00Z');
    noteStartingBefore(at.projectId, at.workstream, '2026-11-06T17:00:00Z');
    expect(startingFor(at.projectId, at.workstream)?.before).toEqual(['2026-11-06T17:00:00Z']);
    markStarting(at.projectId, at.workstream, { ...startingFor(at.projectId, at.workstream)!, pending: false });
    noteStartingBefore(at.projectId, at.workstream, '2026-11-06T17:05:00Z');
    expect(startingFor(at.projectId, at.workstream)?.before).toEqual(['2026-11-06T17:00:00Z']);
  });

  it('stops following once dismissed', async () => {
    begin();
    const d = deps([{ state: 'waking', box: 'termag-20' }]);
    d.sleep = async () => { clearStarting(at.projectId, at.workstream); };
    await runReviewStart(at, 's1', async () => ({ held: true, box: 'termag-20' }), d);
    expect(d.readHeld).not.toHaveBeenCalled();
    expect(startingFor(at.projectId, at.workstream)).toBeNull();
  });
});

describe('Review with Claude as a chat (simple-ui-review-chat-enabled)', () => {
  it('starts on the fixed line naming the PR, then the body as shown, then the review card, with no sign-off line', () => {
    const p = reviewChatPrompt('example-org/termag', 12, '  Also check the migration.\n');
    expect(p.startsWith('Review GitHub pull request #12 (https://github.com/example-org/termag/pull/12) in the repository example-org/termag.')).toBe(true);
    expect(p).toContain('\n\nAlso check the migration.\n\n[termag: the review card]\n');
    expect(p).toContain('"pr":"termag#12"');
    expect(p).toContain("Don't post anything to GitHub: I post from the card.");
    expect(p).not.toContain('Reviewed by');
  });
  it('sends a body cleared in the dialog as it showed: the fixed line and the card, nothing between', () => {
    const p = reviewChatPrompt('example-org/termag', 12, '   ');
    expect(p.startsWith('Review GitHub pull request #12')).toBe(true);
    expect(p).toContain('or none.\n\n[termag: the review card]\n');
    expect(p).not.toContain('\n\n\n');
    expect(p).not.toContain('Can you give a quick description');
  });
  it('keeps the lab\'s PR prompt when nothing was edited', () => {
    expect(reviewSessionPrompt('example-org/termag', 12).startsWith('Can you give a quick description of termag#12')).toBe(true);
  });
  it('says where the chat goes, or why there is nowhere', () => {
    expect(reviewChatWhere('termag', null, 'example-org/termag')).toBe("A chat on the PR's branch, in termag. You talk it through and post.");
    expect(reviewChatWhere(null, 'a new project on box-1', 'acme/web')).toBe("A chat on the PR's branch, in a new project on box-1. You talk it through and post.");
    expect(reviewChatWhere(null, null, 'acme/web')).toBe('No project on acme/web to check it out in');
  });
});

describe('which reviewers are a chat (simple-ui-review-chat-enabled)', () => {
  it("Claude's, Cursor's and Devin's, each as its own chat-runner provider", () => {
    expect(REVIEW_CHAT_PROVIDERS).toEqual({ claude: 'claude-chat', cursor: 'cursor-chat', devin: 'devin-chat' });
  });
  it("Devin's only where every box it runs on says its agent runs Devin; anywhere else, Devin's pane", () => {
    const boxes = [{ id: 'b1', chatEngines: ['cursor', 'devin'] }, { id: 'b2', chatEngines: ['cursor'] }, { id: 'b3' }];
    expect(REVIEW_CHAT_ENGINES).toEqual({ devin: 'devin' });
    expect(reviewChatOnBoxes('devin', ['b1'], boxes)).toBe(true);
    expect(reviewChatOnBoxes('devin', ['b1', 'b1'], boxes)).toBe(true);
    // An older agent, an agent that isn't connected (asleep, waking), a box not listed, a place with no box, none.
    for (const ids of [['b2'], ['b3'], ['b9'], [null], [undefined], ['b1', 'b2'], []]) expect(reviewChatOnBoxes('devin', ids, boxes), JSON.stringify(ids)).toBe(false);
    // Claude's and Cursor's chats don't read the boxes (Cursor's create says engine-missing, as before).
    for (const who of ['claude', 'cursor'] as const) {
      expect(reviewChatOnBoxes(who, [], boxes)).toBe(true);
      expect(reviewChatOnBoxes(who, ['b3'], boxes)).toBe(true);
    }
  });
});

describe('where review chats go (chatPlaces)', () => {
  const proj = (id: string, name: string, workstreams: Array<{ name: string; branch: string }>, extra: Record<string, unknown> = {}) =>
    ({ id, name, repoUrl: 'https://github.com/example-org/termag.git', role: 'owner', lastActiveAt: '2026-11-12T00:00:00Z', workstreams, ...extra }) as unknown as import('../../types').Project;
  const projects = [
    proj('p1', 'termag', [{ name: 'main', branch: 'main' }, { name: 'feat', branch: 'jonny/feat' }]),
    proj('p2', 'ws', [{ name: 'main', branch: 'main' }], { layout: 'workspace' }),
  ];
  const link = (projectId: string, workstream: string) => ({ projectId, projectName: '', workstream });
  const row = (headRefName: string) => ({ headRefName, author: 'a', title: 't', url: 'u' }) as unknown as import('../../services/api').PrRow;

  it("beside a session on its own PR: a branch off that session's, never a second checkout of its branch", () => {
    expect(chatPlaces({ here: { projectId: 'p1', workstream: 'feat' }, repo: 'example-org/termag', number: 7, sessionProject: null, projects }))
      .toEqual([{ repo: 'example-org/termag', number: 7, row: null, at: { projectId: 'p1', projectName: 'termag', workstream: 'feat' }, copyOf: 'feat' }]);
    // A multi-repo project's branch-off spans its repositories: no chat there (the pane stays).
    expect(chatPlaces({ here: { projectId: 'p2', workstream: 'main' }, repo: 'example-org/termag', number: 7, sessionProject: null, projects })).toEqual([]);
  });

  it("a PR: off its review target when that is on the PR's branch, else a new checkout in the target's project", () => {
    const on = chatPlaces({ repo: 'example-org/termag', number: 7, row: row('jonny/feat'), sessionProject: link('p1', 'feat'), projects });
    expect(on[0].copyOf).toBe('feat');
    const off = chatPlaces({ repo: 'example-org/termag', number: 7, row: row('someone/else'), sessionProject: link('p1', 'main'), projects });
    expect(off[0].copyOf).toBeNull();
    expect(off[0].at).toEqual(link('p1', 'main'));
    expect(chatPlaces({ repo: 'example-org/termag', number: 7, sessionProject: null, projects })).toEqual([]);
  });

  it("a group: each open member its own chat, so each card posts to its own PR; one with nowhere is left out", () => {
    const g = group([
      member(1, 'open', { pane: link('p1', 'feat'), row: row('jonny/feat') }),
      member(2, 'open', { repo: 'acme/elsewhere' }),
      member(3, 'open'),
      // A pane on another branch (Bugbot): a checkout in its project, not a branch off a session that isn't on the PR.
      member(4, 'open', { pane: link('p1', 'main'), row: row('jonny/other') }),
      // One the pipeline lists no branch for: its pane's project, and the start copies once GitHub says (copyOfAt).
      member(5, 'open', { pane: link('p1', 'feat') }),
    ]);
    const out = chatPlaces({ group: g, members: reviewChatMembers(g, 'e2e-octocat'), sessionProject: null, projects });
    expect(out.map(p => [p.number, p.copyOf, p.at?.projectId])).toEqual([[1, 'feat', 'p1'], [3, null, 'p1'], [4, null, 'p1'], [5, null, 'p1']]);
  });
  it("a group none of whose members has a pane: each its own chat all the same, in a project on its repository (Bugbot)", () => {
    const g = group([member(1, 'open'), member(2, 'open'), member(3, 'merged')]);
    // The pane review has nowhere to run; the chats each check their PR out.
    expect(groupReviewPlan(g, 'e2e-octocat')).toEqual({ reason: expect.stringMatching(/No checkout to review from/) });
    const out = chatPlaces({ group: g, members: reviewChatMembers(g, 'e2e-octocat'), sessionProject: null, projects });
    expect(out.map(p => [p.number, p.copyOf, p.at?.projectId])).toEqual([[1, null, 'p1'], [2, null, 'p1']]);
  });
});

describe('a review chat where no chat can go, and its copy once the branch is known (Bugbot)', () => {
  it('is the pane where only a pane can go (a multi-repo session), a chat wherever one can or a clone can make one', () => {
    expect(reviewChatsHere(true, 0, false, true)).toBe(false);
    expect(reviewChatsHere(true, 1, false, true)).toBe(true);
    expect(reviewChatsHere(true, 0, true, true)).toBe(true);
    // Nowhere at all: still the chat's, whose button is then off (chatNowhere), never a pane that isn't there.
    expect(reviewChatsHere(true, 0, false, false)).toBe(true);
    expect(reviewChatsHere(false, 1, true, false)).toBe(false);
  });
  it("copies the workstream on the PR's branch once GitHub names it (a pasted or ⌘K PR), else checks the branch out", () => {
    const ws = [{ name: 'main', branch: 'main' }, { name: 'feat', branch: 'jonny/feat' }];
    expect(copyOfAt(null, 'jonny/feat', ws)).toBe('feat');
    expect(copyOfAt(null, 'jonny/other', ws)).toBeNull();
    expect(copyOfAt(null, '', ws)).toBeNull();
    expect(copyOfAt('session-ws', 'jonny/other', ws)).toBe('session-ws');
    // The PR's branch in the project's main checkout: copied too, since git won't check it out twice.
    expect(copyOfAt(null, 'main', ws)).toBe('main');
  });
});
