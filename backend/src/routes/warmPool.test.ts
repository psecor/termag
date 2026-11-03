import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * GET /api/warm-pool's `target`: what the reconciler holds, so the per-size
 * sum when box-warm-pool-sizes serves an object (box-warm-pool-size is not
 * read then), and box-warm-pool-size for the single-size pool.
 */

const flag = vi.hoisted(() => ({ defaultSize: 'medium', poolSize: 5, poolSizes: null as unknown }));
vi.mock('../services/featureFlags', () => ({
  numberVariationForContext: vi.fn(async (_key: string, _ctx: unknown, fallback: number) => flag.poolSize ?? fallback),
  stringVariationForContext: vi.fn(async (key: string, _ctx: unknown, fallback: string) => (key === 'box-default-size' ? flag.defaultSize : fallback)),
  jsonVariationForContext: vi.fn(async (key: string, _ctx: unknown, fallback: unknown) => (key === 'box-warm-pool-sizes' ? flag.poolSizes : fallback)),
  boolVariationForContext: vi.fn(async (_key: string, _ctx: unknown, fallback: boolean) => fallback),
}));
vi.mock('../db', () => ({ prisma: { instance: { count: vi.fn(async () => 0) } } }));
vi.mock('../middleware/auth', () => ({ requireAuth: vi.fn((_req: Request, _res: Response, next: NextFunction) => next()) }));
vi.mock('../services/warmPool', () => ({ lastWarmPoolTick: () => null }));

const { warmPoolRouter } = await import('./warmPool');

interface RouteLayer { route?: { path: string; stack: { handle: RequestHandler }[] } }

/** Runs GET / and resolves with the JSON body once the handler has answered. */
async function get(): Promise<Record<string, unknown>> {
  const layer = (warmPoolRouter().stack as RouteLayer[]).find(l => l.route?.path === '/')!;
  let answered!: (body: Record<string, unknown>) => void;
  const done = new Promise<Record<string, unknown>>(r => { answered = r; });
  const res = Object.assign(new EventEmitter(), {
    status: vi.fn(function (this: unknown) { return this; }),
    json: vi.fn((body: Record<string, unknown>) => { answered(body); }),
  });
  const req = { headers: {}, query: {} } as unknown as Request;
  for (const { handle } of layer.route!.stack) {
    let advanced = false;
    handle(req, res as unknown as Response, () => { advanced = true; });
    await new Promise(r => setImmediate(r));
    if (!advanced) break;
  }
  return done;
}

beforeEach(() => {
  flag.defaultSize = 'medium';
  flag.poolSize = 5;
  flag.poolSizes = null;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('GET /api/warm-pool target', () => {
  it('is the per-size sum when box-warm-pool-sizes serves an object, not box-warm-pool-size', async () => {
    flag.poolSizes = { small: 4, medium: 2, large: 2 };
    const body = await get();
    expect(body.target).toBe(8);
    expect(body.targets).toEqual([{ size: 'small', target: 4 }, { size: 'medium', target: 2 }, { size: 'large', target: 2 }]);
  });

  it('is the clamped total when the counts exceed the ceiling', async () => {
    flag.poolSizes = { small: 15, medium: 15, large: 15 };
    expect((await get()).target).toBe(20);
  });

  it('is box-warm-pool-size for the single-size pool (box-warm-pool-sizes unset)', async () => {
    flag.poolSize = 3;
    const body = await get();
    expect(body.target).toBe(3);
    expect(body.targets).toEqual([{ size: 'medium', target: 3 }]);
  });
});
