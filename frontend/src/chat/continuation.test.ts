import { describe, expect, it } from 'vitest';
import { continuationPolls, continuationStatus, heldToShow } from './continuation';

describe('a chat coming back on its box (docs/chat-resume.md)', () => {
  it('the status line says starting a new box, then restoring, then nothing of its own', () => {
    expect(continuationStatus({ phase: 'starting-box' })?.text).toBe('Starting a new box for this chat…');
    expect(continuationStatus({ phase: 'restoring' })?.text).toBe('Restoring this conversation…');
    expect(continuationStatus({ phase: 'starting' })?.text).toBe('Starting the box…');
    expect(continuationStatus({ held: [{ id: 'm1', text: 'x', error: null }] })).toBeNull();
    expect(continuationStatus(undefined)).toBeNull();
  });

  it('keeps looking while the box comes up or a held message waits, and stops after', () => {
    expect(continuationPolls({ phase: 'restoring' })).toBe(true);
    expect(continuationPolls({ held: [{ id: 'm1', text: 'x', error: null }] })).toBe(true);
    expect(continuationPolls({ held: [{ id: 'm1', text: 'x', error: 'refused' }] })).toBe(false);
    expect(continuationPolls({ sendRefusal: { code: 'owner-only', reason: 'Only Pat can continue this chat' } })).toBe(false);
  });

  it('a held message already on screen (the send\'s pending bubble, or delivered as the newest message) is not shown twice', () => {
    const c = { held: [{ id: 'm1', text: 'hi', error: null }, { id: 'm2', text: 'hi', error: null }, { id: 'm3', text: 'more', error: null }] };
    expect(heldToShow(c, ['hi']).map(m => m.id)).toEqual(['m2', 'm3']);
  });
});
