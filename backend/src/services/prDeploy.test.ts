import { describe, it, expect, vi } from 'vitest';
import { bakeRuns, dispatchBake, newestImage } from './prDeploy';

const TOKEN = 'gho_' + 'x'.repeat(36);
const SHA = 'a'.repeat(40);

function fakeFetch(respond: (url: string, init?: RequestInit) => { status?: number; body?: unknown }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const { status = 200, body } = respond(url, init);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describe('newestImage', () => {
  it('picks the newest dated image and reads its TermagSha', () => {
    expect(newestImage([
      { CreationDate: '2026-10-01T00:00:00Z', Tags: [{ Key: 'TermagSha', Value: 'b'.repeat(40) }] },
      { CreationDate: '2026-10-12T00:00:00Z', Tags: [{ Key: 'TermagSha', Value: SHA }] },
      { Tags: [{ Key: 'TermagSha', Value: 'c'.repeat(40) }] },
    ])).toEqual({ sha: SHA, createdAt: '2026-10-12T00:00:00Z' });
  });
  it('is null with no image, and a null sha for an untagged one', () => {
    expect(newestImage([])).toBeNull();
    expect(newestImage([{ CreationDate: '2026-10-12T00:00:00Z' }])).toEqual({ sha: null, createdAt: '2026-10-12T00:00:00Z' });
  });
});

describe('bakeRuns', () => {
  it('lists the queued and running runs on main', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ body: { workflow_runs: [
      { status: 'in_progress', event: 'schedule', html_url: 'https://github.com/r/1', created_at: '2026-10-12T21:00:00Z' },
      { status: 'completed', event: 'schedule', html_url: 'https://github.com/r/0' },
      { status: 'queued', event: 'workflow_dispatch', html_url: 'https://github.com/r/2', created_at: null },
    ] } }));
    expect(await bakeRuns(TOKEN, fetchImpl)).toEqual([
      { url: 'https://github.com/r/1', status: 'in_progress', event: 'schedule', createdAt: '2026-10-12T21:00:00Z' },
      { url: 'https://github.com/r/2', status: 'queued', event: 'workflow_dispatch', createdAt: null },
    ]);
    expect(calls[0].url).toBe('https://api.github.com/repos/example-org/termag/actions/workflows/publish-ami.yml/runs?branch=main&per_page=10');
  });
  it('is null when GitHub could not say', async () => {
    expect(await bakeRuns(TOKEN, fakeFetch(() => ({ status: 403, body: {} })).fetchImpl)).toBeNull();
  });
});

describe('dispatchBake', () => {
  it('dispatches publish-ami.yml on main for the orchestrator', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 204 }));
    await dispatchBake(TOKEN, fetchImpl);
    expect(calls[0].url).toBe('https://api.github.com/repos/example-org/termag/actions/workflows/publish-ami.yml/dispatches');
    expect(calls[0].init!.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init!.body))).toEqual({ ref: 'main', inputs: { target: 'orchestrator' } });
  });
  it('turns GitHub\'s 404 (no write access) into a 403 that says so', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 404, body: { message: 'Not Found' } }));
    await expect(dispatchBake(TOKEN, fetchImpl)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('cannot run workflows') });
  });
  it('passes another refusal through with its reason', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 422, body: { message: "Unexpected inputs provided: [\"target\"]" } }));
    await expect(dispatchBake(TOKEN, fetchImpl)).rejects.toMatchObject({ status: 422, message: expect.stringContaining('Unexpected inputs') });
  });
});
