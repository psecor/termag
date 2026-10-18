/**
 * Desktop notifications from a terminal program, best effort.
 *
 * Two escape sequences cover most terminals: OSC 777 (rxvt-unicode's
 * `notify`, honoured by WezTerm, foot, kitty with a config knob, iTerm2 ≥3.5)
 * and OSC 9 (iTerm2's original growl hook, also WezTerm/ConEmu). Terminals
 * that know neither ignore them. Inside tmux the sequence has to be wrapped in
 * a DCS passthrough and the server needs `allow-passthrough on` (tmux ≥ 3.3);
 * without it tmux swallows the OSC silently — the bell still rings either way.
 */
const strip = (s: string) => s.replace(/[\x00-\x1f\x7f;]/g, ' ').trim();

export function osc777(title: string, body: string): string {
  return `\x1b]777;notify;${strip(title)};${strip(body)}\x07`;
}

export function osc9(text: string): string {
  return `\x1b]9;${strip(text)}\x07`;
}

/** tmux DCS passthrough: ESC inside the payload is doubled. */
export function tmuxPassthrough(seq: string): string {
  return `\x1bPtmux;${seq.replace(/\x1b/g, '\x1b\x1b')}\x1b\\`;
}

export function notificationSequence(title: string, body: string, env: NodeJS.ProcessEnv = process.env): string {
  const raw = osc777(title, body) + osc9(`${strip(title)}: ${strip(body)}`);
  return env.TMUX ? tmuxPassthrough(raw) : raw;
}

export const BELL = '\x07';
