import { describe, expect, it } from 'vitest';
import { NOTICE_SAFE, chatNoticeText, restartNotice } from './notice';

const base = { tool: 'Claude Code', version: '2.1.320', restart: 'idle', resume: true };

describe('restartNotice', () => {
  it('names the tool, the version and why, for each trigger that restarts sessions', () => {
    expect(restartNotice({ ...base, trigger: 'nightly' })).toBe('[termag] Claude Code was updated to 2.1.320 (automatic nightly run); resuming your session.');
    expect(restartNotice({ ...base, trigger: 'manual' })).toBe('[termag] Claude Code was updated to 2.1.320 (update requested by an admin); resuming your session.');
    expect(restartNotice({ ...base, trigger: 'floor' })).toBe('[termag] Claude Code was updated to 2.1.320 (automatic run: below the minimum version); resuming your session.');
    expect(restartNotice({ ...base, trigger: 'resume', restart: 'force' })).toBe('[termag] Claude Code was updated to 2.1.320 (automatic run after the box resumed); resuming your session.');
  });

  it('says a pane with no conversation starts a new session', () => {
    expect(restartNotice({ ...base, trigger: 'nightly', resume: false })).toBe('[termag] Claude Code was updated to 2.1.320 (automatic nightly run); starting a new session.');
  });

  it('is null when nothing is restarted, or the trigger restarts nothing', () => {
    for (const restart of ['none', null, undefined, 'idle; reboot']) expect(restartNotice({ ...base, trigger: 'nightly', restart })).toBeNull();
    for (const trigger of ['boot', 'guard', null, undefined, 'nightly; reboot', 'constructor', '__proto__']) expect(restartNotice({ ...base, trigger })).toBeNull();
  });

  it('leaves out a version that is not one, and keeps everything a box reported out of the line', () => {
    for (const version of ["2.1.320'; touch /tmp/pwned; echo '", '$(id)', '`id`', '2.1.320\nrm -rf ~', '1'.repeat(41), '', null]) {
      const line = restartNotice({ ...base, trigger: 'nightly', version });
      expect(line).toBe('[termag] Claude Code was updated (automatic nightly run); resuming your session.');
    }
    // Cursor's dated build and Node's are versions.
    expect(restartNotice({ ...base, tool: 'Cursor agent', trigger: 'manual', version: '2026.10.22-27dcf5f' })).toContain('updated to 2026.10.22-27dcf5f ');
  });

  it('is only ever text a shell reads as text', () => {
    for (const bad of ["'", '"', '$', '`', '\\', '\n', '\r', '\x1b', '!', '&', '|', '>', '<', '*', '~', '{', '#']) expect(NOTICE_SAFE.test(`[termag] a${bad}b`)).toBe(false);
    expect(restartNotice({ ...base, tool: "it's", trigger: 'nightly' })).toBeNull();
  });
});

describe('chatNoticeText', () => {
  it('keeps a restart notice, this module\'s or the box\'s, as it is', () => {
    const ours = restartNotice({ ...base, trigger: 'nightly' })!;
    expect(chatNoticeText(ours)).toBe(ours);
    const box = '[termag] Claude Code was updated to 2.1.312; its session was stopped, start it again when you need it.';
    expect(chatNoticeText(box)).toBe(box);
  });

  it('drops anything that is not one, or that NOTICE_SAFE refuses', () => {
    for (const bad of [
      null, undefined, 42, {}, '', 'Claude Code was updated; resuming your session.', ' [termag] x',
      "[termag] it's", '[termag] <img src=x onerror=alert(1)>', '[termag] a\nb', '[termag] ' + 'x'.repeat(200),
    ]) expect(chatNoticeText(bad)).toBeNull();
  });
});
