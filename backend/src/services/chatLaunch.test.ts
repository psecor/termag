import { describe, expect, it } from 'vitest';
import { chatLaunchFor } from './chatLaunch';

const box = { ownerId: 'u1', instanceId: 'box1', capabilities: [] as string[] };

describe('chatLaunchFor on the default backend', () => {
  it('launches a stored tier as itself, and no tier (or the retired "auto") on Sonnet, never without a model', async () => {
    expect(await chatLaunchFor({ backend: null, model: 'opus' }, box)).toEqual({ ok: true, launch: { model: 'opus' } });
    expect(await chatLaunchFor({ backend: null, model: null }, box)).toEqual({ ok: true, launch: { model: 'sonnet' } });
    expect(await chatLaunchFor({ backend: null, model: 'auto' }, box)).toEqual({ ok: true, launch: { model: 'sonnet' } });
  });
});
