import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatusDot } from './StatusDot';
import { STATUS_LABEL } from '../types';

describe('StatusDot', () => {
  it('names each status by the four words, idle "Idle" and waiting "Needs you"', () => {
    expect(STATUS_LABEL).toEqual({ working: 'Working', waiting: 'Needs you', idle: 'Idle', not_running: 'Not running' });
    const html = renderToStaticMarkup(<StatusDot status="idle" />);
    expect(html).toContain('data-status="idle"');
    expect(html).toContain('aria-label="Idle"');
  });
});
