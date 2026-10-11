/**
 * The `rateLimited` status field carries the provider's own words, and not
 * every one of them is a quota: the pi extension sets it for a
 * timeout or a broker 5xx too. Label accordingly so "RATE LIMITED" is not
 * shown over a request that merely failed.
 */
export function rateLimitLabel(message: string): 'RATE LIMITED' | 'PROVIDER ERROR' {
  return /limit|quota|credit|too many|extra usage/i.test(message) ? 'RATE LIMITED' : 'PROVIDER ERROR';
}

export function rateLimitDetail(message: string, provider: string): string {
  return rateLimitLabel(message) === 'RATE LIMITED'
    ? `${provider} is throttled in this pane.`
    : `${provider}'s last request failed in this pane.`;
}
