/** Where Settings' back link goes: the chat list when it was opened from /chat. */
export function settingsBackLink(search: string): { to: string; label: string } {
  return new URLSearchParams(search).get('from') === 'chat'
    ? { to: '/chat', label: '← sessions' }
    : { to: '/', label: '← workspace' };
}
