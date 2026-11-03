// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { scrollMoves } from './scrollMoves';

function scrollOn(target: EventTarget): Event {
  const e = new Event('scroll');
  Object.defineProperty(e, 'target', { value: target });
  return e;
}

describe('scrollMoves', () => {
  const sidebar = document.createElement('div');
  const row = document.createElement('a');
  sidebar.append(row);
  const transcript = document.createElement('div');
  document.body.append(sidebar, transcript);

  it('is a scroll of the page, or of a scroller the element sits in', () => {
    expect(scrollMoves(scrollOn(document), row)).toBe(true);
    expect(scrollMoves(scrollOn(window), row)).toBe(true);
    expect(scrollMoves(scrollOn(sidebar), row)).toBe(true);
  });

  it('is not a scroll of another scroller, the chat following its output', () => {
    expect(scrollMoves(scrollOn(transcript), row)).toBe(false);
  });

  it('moves nothing when there is no element', () => {
    expect(scrollMoves(scrollOn(document), null)).toBe(false);
  });
});
