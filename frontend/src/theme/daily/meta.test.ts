import { describe, expect, it } from 'vitest';
import { metaErrors, parseDailyThemeMeta } from './meta';

const D = '2026-11-05';
const good = { date: D, title: 'Rain', blurb: 'The first rain.', sources: [{ label: 'NWS', url: 'https://api.weather.gov/x' }] };

describe('metaErrors', () => {
  it('passes a whole meta', () => expect(metaErrors(good, D)).toEqual([]));
  it('fails a stale date, markup, a long blurb, a non-https source, unknown keys', () => {
    expect(metaErrors({ ...good, date: '2026-11-04' }, D)).toHaveLength(1);
    expect(metaErrors({ ...good, title: '<b>Rain</b>' }, D)).toHaveLength(1);
    expect(metaErrors({ ...good, blurb: 'x'.repeat(281) }, D)).toHaveLength(1);
    expect(metaErrors({ ...good, sources: [{ label: 'x', url: 'http://example.com' }] }, D)).toHaveLength(1);
    expect(metaErrors({ ...good, sources: [{ label: 'x', url: 'javascript:alert(1)' }] }, D)).toHaveLength(1);
    expect(metaErrors({ ...good, sources: [] }, D)).toHaveLength(1);
    expect(metaErrors({ ...good, html: '<b>' }, D)).toEqual([expect.stringMatching(/unknown keys html/)]);
    expect(metaErrors({ ...good, sources: [{ ...good.sources[0], onclick: 'x' }] }, D)).toEqual([expect.stringMatching(/unknown keys onclick/)]);
    expect(metaErrors(null, D)).toHaveLength(1);
    expect(metaErrors([good], D)).toHaveLength(1);
  });
});

describe('parseDailyThemeMeta', () => {
  it('parses good JSON into a plain copy', () => {
    expect(parseDailyThemeMeta(JSON.stringify(good), D)).toEqual(good);
  });
  it("is null for text that isn't JSON, or a meta that fails the checks", () => {
    expect(parseDailyThemeMeta('export default {}', D)).toBeNull();
    expect(parseDailyThemeMeta(JSON.stringify({ ...good, date: '2026-01-01' }), D)).toBeNull();
  });
});
