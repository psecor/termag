import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlagContext } from './featureFlags';

// box-default-size as a targeting flag source would serve it: a value per context key, else the fallthrough.
const flag = vi.hoisted(() => ({ fallthrough: '', byKey: {} as Record<string, string>, contexts: [] as unknown[] }));

vi.mock('./featureFlags', () => {
  const evaluate = (ctx: FlagContext, fallback: string) => {
    flag.contexts.push(ctx);
    const key = (ctx as { key?: string }).key;
    return key !== undefined && key in flag.byKey ? flag.byKey[key] : flag.fallthrough || fallback;
  };
  return {
    stringVariation: vi.fn(async (_key: string, user: { id: string }, fallback: string) => evaluate({ kind: 'user', key: user.id }, fallback)),
    stringVariationForContext: vi.fn(async (_key: string, ctx: FlagContext, fallback: string) => evaluate(ctx, fallback)),
  };
});

const {
  BOX_SIZES, boxSizeOptions, boxSizeSpec, decideBoxSize, instanceTypesForSize, isBoxSize,
  largestBoxSize, ownerDefaultSize, poolDefaultSize, repoKey, sizeFromFlag,
} = await import('./boxSize');
const { POOL_FLAG_CONTEXT } = await import('./boxHibernationFlag');

beforeEach(() => {
  flag.fallthrough = '';
  flag.byKey = {};
  flag.contexts = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('the sizes and their types', () => {
  it('launches small, medium and large as m8g.large, m8g.xlarge and m8g.2xlarge', () => {
    expect(BOX_SIZES).toEqual(['small', 'medium', 'large']);
    expect(instanceTypesForSize('small', {})?.type).toBe('m8g.large');
    expect(instanceTypesForSize('medium', {})?.type).toBe('m8g.xlarge');
    expect(instanceTypesForSize('large', {})?.type).toBe('m8g.2xlarge');
    expect(boxSizeSpec('small', {})).toMatchObject({ vcpus: 2, memoryGiB: 8 });
    expect(boxSizeSpec('medium', {})).toMatchObject({ vcpus: 4, memoryGiB: 16 });
    expect(boxSizeSpec('large', {})).toMatchObject({ vcpus: 8, memoryGiB: 32 });
  });

  it('falls back within the size: the families beside it at the same vCPU, then the next size up', () => {
    expect(instanceTypesForSize('small', {})?.fallbacks).toEqual(['m7g.large', 'r8g.large', 'r7g.large', 'm8g.xlarge']);
    expect(instanceTypesForSize('medium', {})?.fallbacks).toEqual(['m7g.xlarge', 'r8g.xlarge', 'r7g.xlarge', 'm8g.2xlarge']);
    expect(instanceTypesForSize('large', {})?.fallbacks).toEqual(['m7g.2xlarge', 'r8g.2xlarge', 'r7g.2xlarge', 'm8g.4xlarge']);
  });

  it('is all arm64, which the AMI needs', () => {
    for (const size of BOX_SIZES) {
      for (const type of boxSizeSpec(size, {}).types) expect(type, `${size}: ${type}`).toMatch(/^[a-z]+\d+[a-z]*g[a-z]*\./);
    }
  });

  it('takes a size\'s types from BOX_<SIZE>_INSTANCE_TYPES, the first launched and the rest its fallbacks', () => {
    const env = { BOX_SMALL_INSTANCE_TYPES: ' m7g.large , c7g.xlarge,m7g.large' };
    expect(instanceTypesForSize('small', env)).toEqual({ type: 'm7g.large', fallbacks: ['c7g.xlarge'] });
    expect(instanceTypesForSize('medium', env)?.type).toBe('m8g.xlarge');
  });

  it('drops a non-arm64 type from the env, and keeps the defaults when none is left', () => {
    expect(instanceTypesForSize('small', { BOX_SMALL_INSTANCE_TYPES: 'm7i.large,m7g.large' })).toEqual({ type: 'm7g.large', fallbacks: [] });
    expect(instanceTypesForSize('small', { BOX_SMALL_INSTANCE_TYPES: 'm7i.large' })?.type).toBe('m8g.large');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('m7i.large'));
  });

  it('has no types for no size: the launch walks BOX_INSTANCE_TYPE', () => {
    expect(instanceTypesForSize(null, {})).toBeUndefined();
  });
});

describe('validation', () => {
  it.each(['small', 'medium', 'large'])('accepts %s', (size) => {
    expect(isBoxSize(size)).toBe(true);
    expect(decideBoxSize(size, null, 'small')).toEqual({ ok: true, size, source: 'explicit' });
  });

  it.each(['xl', 'Small', 'm8g.large', 3, true, {}])('refuses %j with a 400, invalid_size', (size) => {
    expect(decideBoxSize(size, null, 'small')).toMatchObject({ ok: false, status: 400, code: 'invalid_size' });
  });

  it('treats an absent, null or empty size as none asked for', () => {
    for (const size of [undefined, null, '']) expect(decideBoxSize(size, null, 'small')).toEqual({ ok: true, size: 'small', source: 'flag' });
  });
});

describe('the default size', () => {
  it('is the flag\'s value for the owner', () => {
    expect(decideBoxSize(undefined, null, 'medium')).toEqual({ ok: true, size: 'medium', source: 'flag' });
  });

  it('is none with the flag off, so the box is the configured type as before', () => {
    expect(decideBoxSize(undefined, null, null)).toEqual({ ok: true, size: null, source: 'configured' });
  });

  it('with the flag off, a size asked for is refused (403) rather than ignored, and the repo file does nothing', () => {
    expect(decideBoxSize('small', null, null)).toMatchObject({ ok: false, status: 403, code: 'box_size_disabled' });
    expect(decideBoxSize(undefined, { size: 'medium' }, null)).toEqual({ ok: true, size: null, source: 'configured' });
  });

  it('an explicit size wins over the repo\'s and the flag\'s', () => {
    expect(decideBoxSize('large', { size: 'medium' }, 'small')).toEqual({ ok: true, size: 'large', source: 'explicit' });
    expect(decideBoxSize('small', { size: 'medium' }, 'small')).toEqual({ ok: true, size: 'small', source: 'explicit' });
  });

  it('reads the flag for the owner, and for the pool\'s fixed context', async () => {
    flag.byKey = { u1: 'small' };
    flag.fallthrough = 'medium';
    expect(await ownerDefaultSize({ id: 'u1' } as never)).toBe('small');
    expect(await ownerDefaultSize({ id: 'u2' } as never)).toBe('medium');
    expect(await poolDefaultSize()).toBe('medium');
    expect(flag.contexts.at(-1)).toBe(POOL_FLAG_CONTEXT);
  });

  it('serves no size for the off variation (""), and for a value it does not know', async () => {
    expect(await ownerDefaultSize({ id: 'u1' } as never)).toBeNull();
    expect(await poolDefaultSize()).toBeNull();
    expect(sizeFromFlag('huge')).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"huge"'));
  });
});

// The size order, for every box (an ask's too): explicit, then the repo's
// .termag/environment.json size (the largest across a multi-repo project's), then
// the flag's default.
const FILE = { size: 'medium' } as const;

describe('the size order', () => {
  it('takes the repo file\'s size over the flag\'s default, larger or smaller', () => {
    expect(decideBoxSize(undefined, FILE, 'small')).toEqual({ ok: true, size: 'medium', source: 'repo' });
    expect(decideBoxSize(undefined, FILE, 'large')).toEqual({ ok: true, size: 'medium', source: 'repo' });
  });

  it('gives requirements back with the default as their fallback', () => {
    expect(decideBoxSize(undefined, { size: { vcpu: 4, memoryGiB: 32 } }, 'large')).toEqual({ ok: true, size: 'large', source: 'repo', requirements: { vcpu: 4, memoryGiB: 32 } });
  });

  it('is the configured type with the flag off', () => {
    expect(decideBoxSize(undefined, FILE, null)).toEqual({ ok: true, size: null, source: 'configured' });
  });

  it('takes an explicit size over the repo file', () => {
    expect(decideBoxSize('small', FILE, 'large')).toEqual({ ok: true, size: 'small', source: 'explicit' });
  });

  it('leaves a repository with no file, or none, at the flag\'s default', () => {
    expect(decideBoxSize(undefined, null, 'small')).toEqual({ ok: true, size: 'small', source: 'flag' });
    expect(decideBoxSize(undefined, { size: null }, 'large')).toEqual({ ok: true, size: 'large', source: 'flag' });
  });

  it('reads a repository as owner/name from a URL in any form', () => {
    for (const repo of [
      'https://github.com/example-org/webapp',
      'https://github.com/example-org/webapp.git',
      'git@github.com:example-org/webapp.git',
      'example-org/webapp',
      'Example-Org/Webapp',
    ]) expect(repoKey(repo), repo).toBe('example-org/webapp');
    expect(repoKey('not a repo')).toBeNull();
  });
});

describe('largestBoxSize: a multi-repo project\'s size, the most of each across its repositories', () => {
  it('takes the most vCPUs and the most memory each on its own: 4/32 and 8/16 make 8/32, which is large', () => {
    expect(largestBoxSize([{ vcpu: 4, memoryGiB: 32 }, { vcpu: 8, memoryGiB: 16 }])).toBe('large');
    expect(largestBoxSize([{ vcpu: 2, memoryGiB: 32 }, { vcpu: 4, memoryGiB: 8 }])).toEqual({ vcpu: 4, memoryGiB: 32 });
  });

  it('counts a preset as its shape, and gives a preset back when the result is one', () => {
    expect(largestBoxSize(['small', 'medium'])).toBe('medium');
    expect(largestBoxSize(['medium', { vcpu: 4, memoryGiB: 32 }])).toEqual({ vcpu: 4, memoryGiB: 32 });
    expect(largestBoxSize(['small', { vcpu: 4, memoryGiB: 16 }])).toBe('medium');
    expect(largestBoxSize(['large', { vcpu: 2, memoryGiB: 16 }])).toBe('large');
  });

  it('skips a repository with nothing to say, and is nothing when none says anything', () => {
    expect(largestBoxSize([null, 'medium', null])).toBe('medium');
    expect(largestBoxSize([null, null])).toBeNull();
    expect(largestBoxSize([])).toBeNull();
  });
});

describe('what the pickers are told', () => {
  it('nothing to pick with the flag off', () => {
    expect(boxSizeOptions(null, {})).toEqual({ enabled: false, default: null, defaultSize: null, sizes: [] });
  });

  it('the sizes with their shape and type, and the owner\'s default, with it on', () => {
    expect(boxSizeOptions('small', {})).toEqual({
      enabled: true,
      default: 'small',
      defaultSize: 'small',
      sizes: [
        { size: 'small', vcpus: 2, memoryGiB: 8, instanceType: 'm8g.large' },
        { size: 'medium', vcpus: 4, memoryGiB: 16, instanceType: 'm8g.xlarge' },
        { size: 'large', vcpus: 8, memoryGiB: 32, instanceType: 'm8g.2xlarge' },
      ],
    });
  });
});
