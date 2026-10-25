import { describe, expect, it } from 'vitest';
import type { BoxLifecycle, Instance } from '../types';
import {
  autoTerminatedText, idleChoiceLabel, idleChoicesFor, lifecycleNote, lifecycleNoteText, offersAutoHibernate,
  terminateChoiceLabel, terminateChoicesFor, terminateNoteText,
} from './boxLifecycle';

const lc = (over: Partial<BoxLifecycle> = {}): BoxLifecycle => ({
  canAutoHibernate: true, idleHibernateHours: null, hibernatedTerminateDays: null, hibernateDueAt: null,
  terminateDueAt: null, parkedAt: null, unsavedWork: null, note: null, warning: null, ...over,
});
const fmt = (d: Date) => d.toISOString().slice(0, 10);
const box = (status: Instance['status'], lifecycle?: BoxLifecycle) => ({ status, lifecycle });

describe('offersAutoHibernate', () => {
  it('needs the flag and a live box, whether or not it can hibernate', () => {
    expect(offersAutoHibernate(box('ready', lc()), true)).toBe(true);
    expect(offersAutoHibernate(box('hibernated', lc()), true)).toBe(true);
    expect(offersAutoHibernate(box('ready', lc({ canAutoHibernate: false })), true)).toBe(true);
    expect(offersAutoHibernate(box('ready', lc()), false)).toBe(false);
    expect(offersAutoHibernate(box('terminated', lc()), true)).toBe(false);
    expect(offersAutoHibernate(box('ready'), true)).toBe(false);
  });
});

describe('lifecycleNoteText', () => {
  it('puts the cannot-hibernate warning first', () => {
    const warning = "This box (or its image) can't hibernate, so auto-park does nothing on it.";
    expect(lifecycleNoteText(box('ready', lc({ canAutoHibernate: false, idleHibernateHours: 1, warning })))).toBe(warning);
  });

  it('shows the setting on a ready box', () => {
    expect(lifecycleNoteText(box('ready', lc({ idleHibernateHours: 2 })))).toBe('Hibernates automatically after 2 h idle.');
    expect(lifecycleNoteText(box('ready', lc()))).toBeNull();
  });

  it('adds the terminate setting on a ready box, or shows it alone', () => {
    expect(lifecycleNoteText(box('ready', lc({ idleHibernateHours: 2, hibernatedTerminateDays: 7 }))))
      .toBe('Hibernates automatically after 2 h idle, and terminates after 7 days hibernated.');
    expect(lifecycleNoteText(box('ready', lc({ hibernatedTerminateDays: 1 })))).toBe('Terminates after 1 day hibernated.');
  });

  it('follows the hibernate note with the terminate date on a parked box', () => {
    const note = 'Hibernated automatically after 1 h idle. Start it to resume where you left off.';
    const parked = lc({
      idleHibernateHours: 1, hibernatedTerminateDays: 1, note, unsavedWork: 'clean',
      parkedAt: '2026-10-01T12:00:00.000Z', terminateDueAt: '2026-10-02T12:00:00.000Z',
    });
    expect(lifecycleNoteText(box('hibernated', parked), fmt)).toBe(`${note} Terminates on 2026-10-02.`);
    expect(lifecycleNoteText(box('hibernating', parked), fmt)).toBe(note);
  });

  it('shows the idle-stop note while the box is stopped or stopping, and not a terminate date', () => {
    const note = 'Stopped automatically after 2 h idle. Start it to get its sessions back.';
    const stopped = lc({
      note, hibernatedTerminateDays: 1,
      parkedAt: '2026-10-01T12:00:00.000Z', terminateDueAt: '2026-10-02T12:00:00.000Z',
    });
    expect(lifecycleNoteText(box('stopped', stopped), fmt)).toBe(note);
    expect(lifecycleNoteText(box('stopping', stopped), fmt)).toBe(note);
    expect(lifecycleNoteText(box('stopped', lc()))).toBeNull();
    expect(lifecycleNote(box('stopped', lc({ note })))).toEqual({ text: 'Auto-stopped', title: note });
    expect(lifecycleNote(box('stopping', lc({ note })))).toEqual({ text: 'Auto-stopped', title: note });
  });

  it('shows what happened while the box is parked, and nothing once it is back', () => {
    const note = 'Hibernated automatically after 1 h idle. Start it to resume where you left off.';
    expect(lifecycleNoteText(box('hibernated', lc({ idleHibernateHours: 1, note })))).toBe(note);
    expect(lifecycleNoteText(box('starting', lc({ idleHibernateHours: 1, note })))).toBeNull();
    expect(lifecycleNoteText(box('hibernated', lc({ idleHibernateHours: 1 })))).toBeNull();
    expect(lifecycleNoteText(box('ready'))).toBeNull();
  });
});

describe('lifecycleNote', () => {
  it('keeps the row to a few words and puts the sentence in the tooltip', () => {
    const warning = "This box (or its image) can't hibernate, so auto-park does nothing on it.";
    expect(lifecycleNote(box('ready', lc({ canAutoHibernate: false, idleHibernateHours: 1, warning }))))
      .toEqual({ text: "Auto-park can't run here", title: warning });
    expect(lifecycleNote(box('ready', lc({ idleHibernateHours: 4 }))))
      .toEqual({ text: 'Auto-park after 4 h idle', title: 'Hibernates automatically after 4 h idle.' });
    const note = 'Hibernated automatically after 1 h idle. Start it to resume where you left off.';
    expect(lifecycleNote(box('hibernated', lc({ idleHibernateHours: 1, note })))).toEqual({ text: 'Auto-parked', title: note });
    expect(lifecycleNote(box('ready', lc()))).toBeNull();
    expect(lifecycleNote(box('ready'))).toBeNull();
  });

  it('shortens both settings on a ready box', () => {
    expect(lifecycleNote(box('ready', lc({ idleHibernateHours: 4, hibernatedTerminateDays: 14 })))?.text).toBe('Park 4 h · terminate 14 d');
    expect(lifecycleNote(box('ready', lc({ hibernatedTerminateDays: 7 })))?.text).toBe('Terminate after 7 d parked');
  });

  it('gives a parked box its terminate date, and a word for why it is later', () => {
    const parked = (over: Partial<BoxLifecycle>) => lc({
      idleHibernateHours: 1, hibernatedTerminateDays: 1, note: 'Hibernated automatically after 1 h idle.',
      parkedAt: '2026-10-01T12:00:00.000Z', terminateDueAt: '2026-10-02T12:00:00.000Z', ...over,
    });
    expect(lifecycleNote(box('hibernated', parked({ unsavedWork: 'clean' })), fmt))
      .toEqual({ text: 'Terminates 2026-10-02', title: 'Hibernated automatically after 1 h idle. Terminates on 2026-10-02.' });
    const later = { terminateDueAt: '2026-12-30T12:00:00.000Z' };
    expect(lifecycleNote(box('hibernated', parked({ ...later, unsavedWork: 'unsaved' })), fmt)?.text).toBe('Terminates 2026-12-30 · unpushed');
    expect(lifecycleNote(box('hibernated', parked({ ...later, unsavedWork: 'unknown' })), fmt)?.text).toBe('Terminates 2026-12-30 · unchecked');
    expect(lifecycleNote(box('hibernating', parked({})), fmt)?.text).toBe('Auto-parked');
  });
});

describe('choices', () => {
  it('labels hours and off', () => {
    expect(idleChoiceLabel(null)).toBe('Off');
    expect(idleChoiceLabel(1)).toBe('After 1 hour idle');
    expect(idleChoiceLabel(8)).toBe('After 8 hours idle');
  });

  it('keeps a value set elsewhere in the list, in order', () => {
    expect(idleChoicesFor(4)).toEqual([null, 1, 2, 4, 8, 24]);
    expect(idleChoicesFor(3)).toEqual([null, 1, 2, 3, 4, 8, 24]);
    expect(idleChoicesFor(72)).toEqual([null, 1, 2, 4, 8, 24, 72]);
  });
});

describe('terminateNoteText', () => {
  const parked = (over: Partial<BoxLifecycle>) => lc({
    hibernatedTerminateDays: 1, parkedAt: '2026-10-01T12:00:00.000Z', terminateDueAt: '2026-10-02T12:00:00.000Z', ...over,
  });

  it('says nothing when no terminate is scheduled', () => {
    expect(terminateNoteText(lc(), fmt)).toBeNull();
    expect(terminateNoteText(parked({ terminateDueAt: null }), fmt)).toBeNull();
  });

  it('gives the date, and why it is later than the setting', () => {
    expect(terminateNoteText(parked({ unsavedWork: 'clean' }), fmt)).toBe('Terminates on 2026-10-02.');
    const later = { terminateDueAt: '2026-12-30T12:00:00.000Z' };
    expect(terminateNoteText(parked({ ...later, unsavedWork: 'unsaved' }), fmt))
      .toBe("Terminates on 2026-12-30. Kept longer: it has work that isn't pushed anywhere.");
    expect(terminateNoteText(parked({ ...later, unsavedWork: 'unknown' }), fmt))
      .toBe("Terminates on 2026-12-30. Kept longer: it couldn't be checked for unpushed work.");
  });

  it("doesn't blame unsaved work when the box's own limit is already the long one", () => {
    expect(terminateNoteText(parked({
      hibernatedTerminateDays: 90, unsavedWork: 'unsaved', terminateDueAt: '2026-12-30T12:00:00.000Z',
    }), fmt)).toBe('Terminates on 2026-12-30.');
  });
});

describe('terminate choices', () => {
  it('labels days and never', () => {
    expect(terminateChoiceLabel(null)).toBe('Never');
    expect(terminateChoiceLabel(1)).toBe('After 1 day hibernated');
    expect(terminateChoiceLabel(30)).toBe('After 30 days hibernated');
  });

  it('keeps a value set elsewhere in the list, in order', () => {
    expect(terminateChoicesFor(7)).toEqual([null, 1, 7, 14, 30, 90]);
    expect(terminateChoicesFor(3)).toEqual([null, 1, 3, 7, 14, 30, 90]);
  });
});

describe('autoTerminatedText', () => {
  it('names the box and says why', () => {
    expect(autoTerminatedText({
      id: 'i', name: 'sub-1', autoTerminatedAt: '2026-10-02T12:00:00.000Z',
      lifecycleNote: 'Terminated automatically after 1 day hibernated.',
    })).toBe('"sub-1": Terminated automatically after 1 day hibernated.');
  });
});
