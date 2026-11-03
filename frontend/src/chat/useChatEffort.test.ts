// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { chatEffortPending, readEffortPick, writeEffortPick } from './useChatEffort';
import { modelMenuPlacement, modelPickerLabel } from './ModelPicker';
import { chatModelOptions } from './composer';

beforeEach(() => localStorage.clear());

describe('effort pick', () => {
  it('is kept per chat; Default and anything unknown read as Default', () => {
    expect(readEffortPick('p|main')).toBe('default');
    writeEffortPick('p|main', 'high');
    expect(readEffortPick('p|main')).toBe('high');
    expect(readEffortPick('q|main')).toBe('default');
    writeEffortPick('p|main', 'default');
    expect(localStorage.getItem('termag.chatEffort.p|main')).toBeNull();
    localStorage.setItem('termag.chatEffort.p|main', 'eleven');
    expect(readEffortPick('p|main')).toBe('default');
  });

  it('is pending only once a message went at another effort', () => {
    expect(chatEffortPending('high', null)).toBe(false);
    expect(chatEffortPending('high', 'high')).toBe(false);
    expect(chatEffortPending('high', 'default')).toBe(true);
  });
});

describe('modelPickerLabel', () => {
  const options = chatModelOptions([]);
  it('names the effort beside the model unless it is Default, not offered, or a Fireworks model', () => {
    expect(modelPickerLabel('opus', options, 'high')).toBe('Opus 5.5 · High');
    expect(modelPickerLabel('opus', options, 'default')).toBe('Opus 5.5');
    expect(modelPickerLabel('opus', options, null)).toBe('Opus 5.5');
    expect(modelPickerLabel('fireworks:accounts/fireworks/models/kimi-k3', options, 'high')).not.toContain('High');
    expect(modelPickerLabel(null, options, 'high')).toBe('…');
  });
});

describe('modelMenuPlacement', () => {
  it('opens above where the menu fits, else on the roomier side, capped to its room', () => {
    // An open session's composer, at the bottom of the window.
    expect(modelMenuPlacement({ above: 600, below: 20 }, 450)).toEqual({ below: false, maxHeight: 600 });
    // New session's, mid-page with a short window: the room above is too small.
    expect(modelMenuPlacement({ above: 213, below: 424 }, 448)).toEqual({ below: true, maxHeight: 424 });
    // Too small either way, more room above: above, scrolling.
    expect(modelMenuPlacement({ above: 300, below: 200 }, 448)).toEqual({ below: false, maxHeight: 300 });
    expect(modelMenuPlacement({ above: -14, below: 754.6 }, 0)).toEqual({ below: true, maxHeight: 754 });
  });
});
