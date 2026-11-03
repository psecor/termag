import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../../chat/sdkChat';
import { agentTranscript } from './AgentTab';

const user = (text: string): ChatItem => ({ kind: 'user', key: `u:${text}`, text });
const said = (text: string): ChatItem => ({ kind: 'text', key: `t:${text}`, text, streaming: false });
const call: ChatItem = { kind: 'tool', key: 'tool:1', id: '1', name: 'Bash', input: {}, inputJson: '', result: 'ok', isError: false, done: true };

describe('the agent tab\'s transcript', () => {
  it('leaves out its brief and its report, which the tab shows around it', () => {
    const items = [user('Run the tests.'), call, said('All 14 pass.')];
    expect(agentTranscript({ items, prompt: 'Run the tests.', report: 'All 14 pass.', status: 'done' }, null)).toEqual([call]);
    // While it runs its last words aren't its report yet.
    expect(agentTranscript({ items, prompt: 'Run the tests.', report: 'All 14 pass.', status: 'running' }, null)).toEqual([call, said('All 14 pass.')]);
  });

  it('weighs the file against what streamed without the brief, which only the file may have', () => {
    // A background subagent's stream: no prompt, two steps. The file, read a moment ago: the prompt and one step.
    expect(agentTranscript({ items: [call, said('two')], prompt: 'go', report: null, status: 'running' }, [user('go'), call])).toEqual([call, said('two')]);
  });

  it('is the box\'s file once read, unless what streamed is further along', () => {
    const live = [user('go'), call, said('one')];
    expect(agentTranscript({ items: live, prompt: 'go', report: null, status: 'running' }, [user('go')])).toEqual([call, said('one')]);
    expect(agentTranscript({ items: [], prompt: 'go', report: null, status: 'done' }, live)).toEqual([call, said('one')]);
  });
});
