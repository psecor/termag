import { describe, expect, it } from 'vitest';
import { paneCheckoutReady, shouldWaitForPaneCheckout, waitForPaneCheckout } from './paneCheckout';

const delivered = new Date('2026-10-07T00:00:00Z');

describe('shouldWaitForPaneCheckout', () => {
  it('is true only when the create is a repo on a managed box with GitHub connected', () => {
    expect(shouldWaitForPaneCheckout({ hasRepo: true, managed: true, hasGithubCredential: true })).toBe(true);
    expect(shouldWaitForPaneCheckout({ hasRepo: false, managed: true, hasGithubCredential: true })).toBe(false);
    expect(shouldWaitForPaneCheckout({ hasRepo: true, managed: false, hasGithubCredential: true })).toBe(false);
    expect(shouldWaitForPaneCheckout({ hasRepo: true, managed: true, hasGithubCredential: false })).toBe(false);
  });
});

describe('paneCheckoutReady', () => {
  it('is ready when GitHub has been delivered and the claim is settled', () => {
    for (const onClaimStatus of ['succeeded', 'failed', 'skipped', null]) {
      expect(paneCheckoutReady({ githubDeliveredAt: delivered, onClaimStatus })).toBe(true);
    }
  });

  it('is not ready when delivery has not landed, or the claim is still going', () => {
    expect(paneCheckoutReady({ githubDeliveredAt: null, onClaimStatus: 'succeeded' })).toBe(false);
    expect(paneCheckoutReady({ githubDeliveredAt: delivered, onClaimStatus: 'pending' })).toBe(false);
    expect(paneCheckoutReady({ githubDeliveredAt: delivered, onClaimStatus: 'running' })).toBe(false);
  });

  it('is not ready for a newly claimed warm box until GitHub delivery stamps', () => {
    const warmClaim = {
      githubDeliveredAt: null,
      onClaimStatus: 'skipped',
      lastConnectedAt: new Date('2026-10-06T00:00:00Z'),
    };
    expect(paneCheckoutReady(warmClaim)).toBe(false);
  });

  it('is ready when a claimed box already has a GitHub delivery stamp', () => {
    const claimed = {
      githubDeliveredAt: delivered,
      onClaimStatus: 'skipped',
      lastConnectedAt: new Date('2026-10-06T00:00:00Z'),
    };
    expect(paneCheckoutReady(claimed)).toBe(true);
  });

  it('still waits when an established connection is mid-claim', () => {
    const claimed = {
      githubDeliveredAt: null,
      onClaimStatus: 'pending' as string | null,
      lastConnectedAt: new Date('2026-10-06T00:00:00Z'),
    };
    expect(paneCheckoutReady(claimed)).toBe(false);
    expect(paneCheckoutReady({ ...claimed, onClaimStatus: 'running' })).toBe(false);
  });

  it('does not block when the instance row is gone', () => {
    expect(paneCheckoutReady(null)).toBe(true);
  });
});

describe('waitForPaneCheckout', () => {
  it('returns ready on the first ready read and does not sleep', async () => {
    const sleeps: number[] = [];
    const result = await waitForPaneCheckout(
      async () => ({ githubDeliveredAt: delivered, onClaimStatus: 'succeeded' }),
      { sleep: async ms => { sleeps.push(ms); }, now: () => 0 },
    );
    expect(result).toBe('ready');
    expect(sleeps).toEqual([]);
  });

  it('waits out a newly claimed warm box whose connect predates delivery', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const result = await waitForPaneCheckout(
      async () => ({
        githubDeliveredAt: null,
        onClaimStatus: 'skipped',
        lastConnectedAt: new Date('2026-10-06T00:00:00Z'),
      }),
      {
        timeoutMs: 1000,
        intervalMs: 250,
        now: () => t,
        sleep: async ms => { sleeps.push(ms); t += ms; },
      },
    );
    expect(result).toBe('timeout');
    expect(sleeps).toEqual([250, 250, 250, 250]);
  });

  it('returns timeout when the row stays unready and the clock advances through sleep', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const result = await waitForPaneCheckout(
      async () => ({ githubDeliveredAt: null, onClaimStatus: 'pending' }),
      {
        timeoutMs: 1000,
        intervalMs: 250,
        now: () => t,
        sleep: async ms => { sleeps.push(ms); t += ms; },
      },
    );
    expect(result).toBe('timeout');
    expect(sleeps).toEqual([250, 250, 250, 250]);
  });
});
