import { Terminal, type ITerminalOptions } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import 'xterm/css/xterm.css';
import { guardViewportAfterDispose } from '../utils/xtermLifecycle';

export interface OpenedTerminal {
  term: Terminal;
  /** Size the terminal to its container. */
  fit: () => void;
}

/**
 * A pane's xterm, with the addons every pane loads, opened in `container`.
 * The addons go through loadAddon, so term.dispose() disposes them too.
 */
export function openTerminal(container: HTMLElement, options: ITerminalOptions): OpenedTerminal {
  const term = new Terminal(options);
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon());
  term.open(container);
  guardViewportAfterDispose(term);
  return { term, fit: () => fitAddon.fit() };
}
