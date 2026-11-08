import { describe, expect, it, vi } from 'vitest';

// The axios instance api.ts creates, answering GET /api/projects.
const get = vi.hoisted(() => vi.fn(async () => ({
  data: [
    { id: 'p-app', name: 'app', kind: 'normal' },
    { id: 'p-meta', name: 'metaterm', kind: 'metaterm' },
    { id: 'p-space', name: 'space-design', kind: 'space-orchestrator' },
  ],
})));
vi.mock('axios', () => ({
  default: { create: () => ({ get, post: vi.fn(), put: vi.fn(), delete: vi.fn(), interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } }, defaults: { headers: { common: {} } } }) },
}));

import { projectsApi } from './api';
import { projectWithLabel } from '../utils/projectKind';

describe('the sidebar project list', () => {
  // Navigation never shows a space orchestrator (utils/projectKind.ts inProjectLists),
  // even should an older backend send one; confirmations name it instead.
  it('leaves a space orchestrator out, and keeps MetaTerm and normal projects', async () => {
    expect((await projectsApi.list()).map(p => p.id)).toEqual(['p-app', 'p-meta']);
    expect(get).toHaveBeenCalledWith('/api/projects');
  });

  it('names a labelled project with its label in a confirmation', () => {
    expect(projectWithLabel({ name: 'space-design', label: 'space orchestrator for design' })).toBe('space-design (space orchestrator for design)');
    expect(projectWithLabel({ name: 'app' })).toBe('app');
  });
});
