import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../middleware/admin', () => ({ recordAudit: vi.fn() }));
vi.mock('../services/software/queries', () => ({ softwareMatrix: vi.fn(), softwareHost: vi.fn(), clientVersions: vi.fn() }));

import { buildServer } from './adminServer';
import { softwareMatrix } from '../services/software/queries';

const counts = (current: number) => ({ current, behind: 0, outdated: 0, ahead: 0, missing: 0, unknown: 0 });
const row = (current: number) => [{ component: 'claude', reference: '2.1.312', referenceNote: '', counts: counts(current), spread: [] }];
const matrix = { components: ['claude'], summary: row(9), online: { summary: row(4), offline: 5 }, hosts: [], targets: { boxCommit: 'abc' }, collector: { lastError: null }, generatedAt: '' };

async function call(args: Record<string, unknown>) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer({ id: 'admin', tokenId: null }).connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  const res = await client.callTool({ name: 'software_summary', arguments: args });
  await client.close();
  return JSON.parse((res.content as Array<{ text: string }>)[0].text);
}

describe('software_summary', () => {
  beforeEach(() => { vi.mocked(softwareMatrix).mockResolvedValue(matrix as never); });

  it('passed nothing, answers both sets with `summary` over every host as before', async () => {
    const out = await call({});
    expect(out.hosts).toBe('both');
    expect(out.summary[0].counts.current).toBe(9);
    expect(out.online).toEqual({ summary: row(4), offline: 5 });
    expect(out.targets).toEqual({ boxCommit: 'abc' });
  });

  it('online answers only the online counts', async () => {
    const out = await call({ hosts: 'online' });
    expect(out.summary).toBeUndefined();
    expect(out.online.summary[0].counts.current).toBe(4);
    expect(out.counted).toMatch(/5 offline left out/);
  });

  it('all answers every host and the offline count', async () => {
    const out = await call({ hosts: 'all' });
    expect(out.online).toBeUndefined();
    expect(out.summary[0].counts.current).toBe(9);
    expect(out.offline).toBe(5);
  });

  it('describes the default and refuses an unknown mode', async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await buildServer({ id: 'admin', tokenId: null }).connect(a);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(b);
    const tool = (await client.listTools()).tools.find(t => t.name === 'software_summary')!;
    expect(tool.description).toMatch(/"both" \(the default/);
    const bad = await client.callTool({ name: 'software_summary', arguments: { hosts: 'live' } });
    expect(bad.isError).toBe(true);
    await client.close();
  });
});
