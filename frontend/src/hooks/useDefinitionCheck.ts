import { useEffect, useRef, useState } from 'react';
import { environmentsApi } from '../services/api';
import { definitionError } from '../utils/environments';

/** How long the text rests before an error already shown is checked again with the server. */
const RECHECK_MS = 300;

/**
 * An inline environment definition's check, shown
 * only once the editor has lost focus or a save was tried, never while the
 * first draft is typed. Once shown it follows the text: the JSON at once, and
 * the server's schema check after a short rest, so it clears as soon as the
 * definition is valid. Nothing is disabled on it; `check()` is what a save
 * runs first, and it shows the errors it finds.
 */
export function useDefinitionCheck(text: string, active: boolean) {
  const [shown, setShown] = useState(false);
  const [serverErrors, setServerErrors] = useState<{ text: string; errors: string[] } | null>(null);
  const seq = useRef(0);

  const ask = async (t: string): Promise<string[]> => {
    const local = definitionError(t);
    if (local) return [local];
    const mine = ++seq.current;
    try {
      const errors = await environmentsApi.validate(t);
      if (mine === seq.current) setServerErrors({ text: t, errors });
      return errors;
    } catch {
      // The server says it at save, then; nothing to show now.
      return [];
    }
  };

  useEffect(() => {
    if (!active || !shown || definitionError(text)) return;
    const timer = setTimeout(() => { void ask(text); }, RECHECK_MS);
    return () => clearTimeout(timer);
  }, [text, shown, active]);

  const local = active ? definitionError(text) : null;
  const errors = !active || !shown ? []
    : local ? [local]
    : serverErrors?.text === text ? serverErrors.errors : [];

  return {
    errors,
    /** The editor lost focus: show what is wrong from now on. */
    onBlur: () => { if (!active) return; setShown(true); void ask(text); },
    /** Before a save: true when there is nothing to show; else the errors show. */
    check: async (): Promise<boolean> => {
      if (!active) return true;
      setShown(true);
      return (await ask(text)).length === 0;
    },
    /** Errors the server answered a save with, shown like the check's. */
    showServer: (t: string, list: string[]) => { setShown(true); setServerErrors({ text: t, errors: list }); },
  };
}
