import { describe, expect, it } from 'vitest';
import { settingsDocsHref } from './settingsDocs';

describe('settings docs links', () => {
  it('deep-links a configured docs site: the Docs tab, the settings doc, the heading', () => {
    expect(settingsDocsHref('ssh-into-a-box', 'https://docs.example.com/'))
      .toBe('https://docs.example.com/#/docs?doc=settings&h=ssh-into-a-box');
  });

  it('has no link when no docs site is configured', () => {
    expect(settingsDocsHref('ssh-into-a-box', '')).toBeNull();
  });
});
