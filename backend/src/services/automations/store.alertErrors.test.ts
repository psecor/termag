import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ prisma: {} }));

import { alertErrorsView } from './store';

const t = (hhmm: string) => new Date(`2026-11-12T${hhmm}:00Z`);
const none = { lastSlackError: null, lastSlackErrorAt: null, lastWebhookError: null, lastWebhookErrorAt: null, lastAlertError: null, lastAlertErrorAt: null };

describe('alertErrorsView', () => {
  it('reads each channel from its own columns, and names the newer for older CLIs', () => {
    expect(alertErrorsView({ ...none, lastSlackError: 'not_in_channel', lastSlackErrorAt: t('10:00'), lastWebhookError: 'answered 503', lastWebhookErrorAt: t('11:00') })).toEqual({
      lastAlertErrors: { slack: { error: 'not_in_channel', at: t('10:00').toISOString() }, webhook: { error: 'answered 503', at: t('11:00').toISOString() } },
      lastAlertError: { error: 'webhook: answered 503', at: t('11:00').toISOString() },
    });
    expect(alertErrorsView(none)).toEqual({ lastAlertErrors: { slack: null, webhook: null }, lastAlertError: null });
  });

  it('a failure only in the legacy column (from before the upgrade, or an old orchestrator mid-deploy) shows on its channel', () => {
    expect(alertErrorsView({ ...none, lastAlertError: 'Slack: not_in_channel', lastAlertErrorAt: t('10:00') }).lastAlertErrors)
      .toEqual({ slack: { error: 'not_in_channel', at: t('10:00').toISOString() }, webhook: null });
    expect(alertErrorsView({ ...none, lastAlertError: 'webhook: answered 410', lastAlertErrorAt: t('10:00') }).lastAlertErrors)
      .toEqual({ slack: null, webhook: { error: 'answered 410', at: t('10:00').toISOString() } });
    // Newer than the channel's last success (its At, error cleared): an old orchestrator's fresh failure.
    expect(alertErrorsView({ ...none, lastSlackErrorAt: t('09:00'), lastAlertError: 'Slack: not_in_channel', lastAlertErrorAt: t('10:00') }).lastAlertErrors.slack)
      .toEqual({ error: 'not_in_channel', at: t('10:00').toISOString() });
  });

  it('a stale legacy failure never comes back after a newer success on its channel, nor shows on the other', () => {
    const r = alertErrorsView({ ...none, lastSlackErrorAt: t('11:00'), lastAlertError: 'Slack: not_in_channel', lastAlertErrorAt: t('10:00') });
    expect(r).toEqual({ lastAlertErrors: { slack: null, webhook: null }, lastAlertError: null });
    expect(alertErrorsView({ ...none, lastSlackErrorAt: t('10:00'), lastAlertError: 'Slack: x', lastAlertErrorAt: t('10:00') }).lastAlertErrors.slack).toBeNull();
    // Both hold a failure for the channel: the newer shows, whichever column it is in.
    const both = { ...none, lastSlackError: 'channel_not_found', lastAlertError: 'Slack: not_in_channel' };
    expect(alertErrorsView({ ...both, lastSlackErrorAt: t('09:00'), lastAlertErrorAt: t('10:00') }).lastAlertErrors.slack)
      .toEqual({ error: 'not_in_channel', at: t('10:00').toISOString() });
    expect(alertErrorsView({ ...both, lastSlackErrorAt: t('11:00'), lastAlertErrorAt: t('10:00') }).lastAlertErrors.slack)
      .toEqual({ error: 'channel_not_found', at: t('11:00').toISOString() });
    // A cleared legacy row, or one naming no channel, stands in for nothing.
    expect(alertErrorsView({ ...none, lastAlertError: null, lastAlertErrorAt: t('10:00') }).lastAlertErrors).toEqual({ slack: null, webhook: null });
    expect(alertErrorsView({ ...none, lastAlertError: 'something else', lastAlertErrorAt: t('10:00') }).lastAlertErrors).toEqual({ slack: null, webhook: null });
  });
});
