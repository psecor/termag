import { describe, expect, it } from 'vitest';
import { metatermVisibility } from './metatermVisibility';

describe('metatermVisibility', () => {
  it('hides everything for a user who has not opted in', () => {
    expect(metatermVisibility({ optedIn: false, metatermId: null, activeProjectId: null })).toEqual({ showRow: false, showEntry: false });
    expect(metatermVisibility({ optedIn: false, metatermId: 'mt', activeProjectId: 'other' })).toEqual({ showRow: false, showEntry: false });
  });

  it('keeps an existing MetaTerm listed while it is the open project', () => {
    expect(metatermVisibility({ optedIn: false, metatermId: 'mt', activeProjectId: 'mt' })).toEqual({ showRow: true, showEntry: false });
  });

  it('offers the entry when opted in and there is no MetaTerm yet', () => {
    expect(metatermVisibility({ optedIn: true, metatermId: null, activeProjectId: null })).toEqual({ showRow: false, showEntry: true });
  });

  it('shows the row, not the entry, when opted in and it exists', () => {
    expect(metatermVisibility({ optedIn: true, metatermId: 'mt', activeProjectId: 'other' })).toEqual({ showRow: true, showEntry: false });
  });
});
