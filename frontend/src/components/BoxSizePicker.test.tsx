// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoxSizeOptions, SizePick } from '../utils/boxSize';
import { boxSizeBadge, preselectedSize, sizeOptionLabel, sizeOptionParts, sizeToSend } from '../utils/boxSize';

vi.mock('../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));
const { BoxSizeBadge, BoxSizeField, BoxSizeSelect } = await import('./BoxSizePicker');

const OPTIONS: BoxSizeOptions = {
  enabled: true,
  default: 'medium',
  defaultSize: 'medium',
  sizes: [
    { size: 'small', vcpus: 2, memoryGiB: 8, instanceType: 'm8g.large' },
    { size: 'medium', vcpus: 4, memoryGiB: 16, instanceType: 'm8g.xlarge' },
    { size: 'large', vcpus: 8, memoryGiB: 32, instanceType: 'm8g.2xlarge' },
  ],
};
// GET /api/instances/sizes?repo= for a repo whose .termag/environment.json says large, and one that asks for 4 vCPU / 32 GB.
const LARGE_REPO: BoxSizeOptions = { ...OPTIONS, defaultSize: 'large' };
const R8G_REPO: BoxSizeOptions = { ...OPTIONS, defaultSize: 'small', defaultRequirements: { vcpu: 4, memoryGiB: 32, instanceType: 'r8g.xlarge' } };
const LABELS = ['Small · 2 vCPU, 8 GB RAM', 'Medium · 4 vCPU, 16 GB RAM', 'Large · 8 vCPU, 32 GB RAM'];

describe('the labels and the preselection', () => {
  it('labels each size from the size table', () => {
    expect(OPTIONS.sizes.map(sizeOptionLabel)).toEqual(LABELS);
    expect(sizeOptionLabel({ size: 'small', vcpus: 4, memoryGiB: 16 })).toBe('Small · 4 vCPU, 16 GB RAM');
    expect(sizeOptionParts({ size: 'medium', vcpus: 4, memoryGiB: 16 })).toEqual({ name: 'Medium', specs: '4 vCPU, 16 GB RAM' });
  });

  it('preselects what the server says a box for the repo launches at', () => {
    expect(preselectedSize(OPTIONS)).toBe('medium');
    expect(preselectedSize({ ...OPTIONS, defaultSize: 'small' })).toBe('small');
    expect(preselectedSize(LARGE_REPO)).toBe('large');
  });

  it('preselects the repo\'s own entry when its environment.json asks for requirements', () => {
    expect(preselectedSize(R8G_REPO)).toBe('repo');
  });

  it('takes `default` from an orchestrator that predates defaultSize', () => {
    expect(preselectedSize({ ...OPTIONS, defaultSize: undefined, default: 'large' })).toBe('large');
    expect(preselectedSize({ ...OPTIONS, defaultSize: undefined, default: null })).toBe('medium');
  });

  it('sends a picked preset, and nothing for the preselection or the repo entry, so the server sizes it by the same order', () => {
    expect(sizeToSend(OPTIONS, 'small')).toBe('small');
    expect(sizeToSend(OPTIONS, null)).toBeUndefined();
    expect(sizeToSend(R8G_REPO, 'repo')).toBeUndefined();
    expect(sizeToSend(null, 'large')).toBeUndefined();
  });
});

describe('a box\'s size in the lists', () => {
  it('reads as its size, with the type it got in the tooltip', () => {
    expect(boxSizeBadge('small', 'r8g.large')).toEqual({ label: 'small', title: 'small: launched as r8g.large' });
  });

  it('reads as its type alone for a box sized by a repo\'s requirements', () => {
    expect(boxSizeBadge('4vcpu-32gib', 'r8g.xlarge')).toEqual({ label: 'r8g.xlarge', title: "r8g.xlarge: at least 4 vCPU, 32 GB RAM, from the repository's .termag/environment.json" });
    expect(boxSizeBadge('4vcpu-32gib', null)?.label).toBe('4vcpu-32gib');
  });

  it('reads as the type for a box launched with no size, and as nothing when neither was recorded', () => {
    expect(boxSizeBadge(null, 'm9g.2xlarge')).toEqual({ label: 'm9g.2xlarge', title: expect.stringContaining('configured type') });
    expect(boxSizeBadge(null, null)).toBeNull();
  });
});

let root: Root;
let el: HTMLDivElement;
beforeEach(() => {
  // React Aria escapes ids with CSS.escape, which jsdom lacks (as RepoPicker.test.tsx).
  const css = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS;
  if (!css?.escape) (globalThis as { CSS?: unknown }).CSS = { ...css, escape: (v: string) => v.replace(/[^\w-]/g, c => `\\${c}`) };
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); });

describe('BoxSizeSelect (simple UI): LaunchPad\'s Select', () => {
  const render = (picked: SizePick | null, options: BoxSizeOptions = OPTIONS, onPick: (s: SizePick) => void = () => {}) =>
    act(() => root.render(<BoxSizeSelect options={options} picked={picked} onPick={onPick} />));
  const trigger = () => el.querySelector('.box-size-select-button') as HTMLButtonElement;
  const shown = () => trigger().textContent?.replace(/\s+/g, ' ').trim();
  const options = () => [...document.querySelectorAll('.box-size-select-popover [role="option"]')] as HTMLElement[];
  const open = async () => { await act(async () => { trigger().click(); }); };

  it('is LaunchPad\'s Select in termag\'s theme, labelled Size, showing Medium', () => {
    render(null);
    expect(el.querySelector('.lp-theme.box-size-select')).not.toBeNull();
    expect(el.querySelector('.box-size-select-label')?.textContent).toBe('Size');
    expect(trigger().getAttribute('aria-labelledby')).toContain(el.querySelector('.box-size-select-label')?.id);
    expect(shown()).toBe('Medium · 4 vCPU, 16 GB RAM');
    expect(trigger().querySelector('.box-size-name')?.textContent).toBe('Medium');
    expect(trigger().querySelector('.box-size-specs')?.textContent).toBe(' · 4 vCPU, 16 GB RAM');
  });

  it('opens to the three labelled options, Medium selected, the name emphasised and the specs muted', async () => {
    render(null);
    await open();
    expect(options().map(o => o.textContent)).toEqual(LABELS);
    expect(options().filter(o => o.getAttribute('aria-selected') === 'true').map(o => o.querySelector('.box-size-name')?.textContent)).toEqual(['Medium']);
    expect(options().every(o => o.querySelector('.box-size-name') && o.querySelector('.box-size-specs'))).toBe(true);
    expect(document.querySelector('.box-size-select-popover')?.classList.contains('lp-theme')).toBe(true);
  });

  it('preselects the owner\'s large default', () => {
    render(null, { ...OPTIONS, defaultSize: 'large' });
    expect(shown()).toBe('Large · 8 vCPU, 32 GB RAM');
  });

  it('starts at the repo file\'s size', () => {
    render(null, LARGE_REPO);
    expect(shown()).toBe('Large · 8 vCPU, 32 GB RAM');
  });

  it('puts the repo\'s own type, r8g.xlarge, above Small, Medium and Large, preselected, and reports picking it', async () => {
    const onPick = vi.fn();
    render(null, R8G_REPO, onPick);
    expect(shown()).toBe('r8g.xlarge');
    await open();
    expect(options().map(o => o.textContent)).toEqual(['r8g.xlarge', ...LABELS]);
    expect(options().filter(o => o.getAttribute('aria-selected') === 'true').map(o => o.textContent)).toEqual(['r8g.xlarge']);
    await act(async () => { options()[2].click(); });
    expect(onPick).toHaveBeenCalledWith('medium');
  });

  it('reports a pick; the pick shows over the preselection', async () => {
    const onPick = vi.fn();
    render(null, OPTIONS, onPick);
    await open();
    await act(async () => { options()[0].click(); });
    expect(onPick).toHaveBeenCalledWith('small');
    render('small');
    expect(shown()).toBe('Small · 2 vCPU, 8 GB RAM');
  });
});

describe('BoxSizeField (full UI): a native select like the form\'s Agent field', () => {
  const select = () => el.querySelector('#npf-box-size') as HTMLSelectElement;

  it('lists the three labelled sizes with the default, Medium, selected', () => {
    act(() => root.render(<BoxSizeField options={OPTIONS} picked={null} onPick={() => {}} />));
    expect([...select().options].map(o => o.textContent)).toEqual(LABELS);
    expect(select().value).toBe('medium');
  });

  it('starts at the repo file\'s size, and reports a pick', () => {
    const onPick = vi.fn();
    act(() => root.render(<BoxSizeField options={LARGE_REPO} picked={null} onPick={onPick} />));
    expect(select().value).toBe('large');
    act(() => { select().value = 'small'; select().dispatchEvent(new Event('change', { bubbles: true })); });
    expect(onPick).toHaveBeenCalledWith('small');
  });

  it('lists the repo\'s own type first, selected, when its environment.json asks for requirements', () => {
    act(() => root.render(<BoxSizeField options={R8G_REPO} picked={null} onPick={() => {}} />));
    expect([...select().options].map(o => o.textContent)).toEqual(['r8g.xlarge', ...LABELS]);
    expect(select().value).toBe('repo');
  });
});

describe('BoxSizeBadge', () => {
  it('renders the size, and nothing without one', () => {
    act(() => root.render(<><BoxSizeBadge size="medium" instanceType="m8g.xlarge" /><BoxSizeBadge size="4vcpu-32gib" instanceType="r8g.xlarge" /><BoxSizeBadge /></>));
    expect([...el.querySelectorAll('.box-size-badge')].map(b => b.textContent)).toEqual(['medium', 'r8g.xlarge']);
  });

  it('puts the disk it was made with in the size\'s tooltip, and shows it alone for a box with no size', () => {
    act(() => root.render(<>
      <BoxSizeBadge size="medium" instanceType="m8g.xlarge" diskGiB={200} />
      <BoxSizeBadge diskGiB={120} />
      <BoxSizeBadge size="small" />
    </>));
    expect([...el.querySelectorAll('.box-size-badge')].map(b => [b.textContent, b.getAttribute('title')])).toEqual([
      ['medium', 'medium: launched as m8g.xlarge · 200 GB disk'], ['120 GB', '120 GB disk'], ['small', 'small'],
    ]);
  });
});
