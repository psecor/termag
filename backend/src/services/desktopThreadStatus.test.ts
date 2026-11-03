import { beforeEach, describe, expect, it, vi } from 'vitest';

const findFirst = vi.hoisted(() => vi.fn());
vi.mock('../db', () => ({ prisma: { workstream: { findFirst } } }));

import { chatStatusSessionFor, resetDesktopThreadStatusForTests } from './desktopThreadStatus';

const SID = '0334b447-41c0-4f95-ba90-d74fcfdaa69d';

beforeEach(() => { resetDesktopThreadStatusForTests(); findFirst.mockReset(); });

describe('chatStatusSessionFor', () => {
  it("names the chat on this box that holds the thread's Claude session, by its own session id or an imported thread's", async () => {
    findFirst.mockResolvedValue({ name: 'main', project: { name: 'parity-test-chat2', user: { unixUsername: 'jsmith' } } });
    expect(await chatStatusSessionFor('box-1', SID, 0)).toBe('jsmith-parity-test-chat2-agent');
    expect(findFirst.mock.calls[0][0].where).toEqual({
      archived: false,
      project: { instanceId: 'box-1', archived: false },
      OR: [{ chatSessionId: SID }, { t3ThreadId: { endsWith: `:${SID}` } }],
    });
    findFirst.mockResolvedValue({ name: 'fix-ci', project: { name: 'svc', user: { unixUsername: 'jsmith' } } });
    expect(await chatStatusSessionFor('box-1', 'other-session-1', 0)).toBe('jsmith-svc-fix-ci-agent');
  });

  it('asks once a minute per thread, a miss included', async () => {
    findFirst.mockResolvedValue(null);
    expect(await chatStatusSessionFor('box-1', SID, 0)).toBeNull();
    expect(await chatStatusSessionFor('box-1', SID, 59_000)).toBeNull();
    expect(findFirst).toHaveBeenCalledTimes(1);
    findFirst.mockResolvedValue({ name: 'main', project: { name: 'p', user: { unixUsername: 'u' } } });
    expect(await chatStatusSessionFor('box-1', SID, 61_000)).toBe('u-p-agent');
    expect(findFirst).toHaveBeenCalledTimes(2);
  });
});
