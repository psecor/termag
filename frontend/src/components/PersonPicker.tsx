import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usersApi, type PersonMatch } from '../services/api';
import { browserStorage, personMatches, readRecentPeople } from '../utils/recentPeople';

/** Wait this long after the last keystroke before asking the server. */
export const PERSON_SEARCH_DEBOUNCE_MS = 150;
const MIN_QUERY = 2;
const LIST_MAX_HEIGHT = 260;
/** Below the field unless fewer than this many pixels are left there and more are above. */
const LIST_MIN_ROOM = 160;

/**
 * Where the list goes, in viewport pixels: under the field, or over it when
 * the room below is short and there is more above. Fixed and portalled, so a
 * scrolling pane around the field (the space members tab) can't clip it.
 */
export function listPlacement(field: { left: number; top: number; bottom: number; width: number }, viewportHeight: number): React.CSSProperties {
  const below = viewportHeight - field.bottom - 8;
  const above = field.top - 8;
  if (below < LIST_MIN_ROOM && above > below) {
    return { left: field.left, width: field.width, bottom: viewportHeight - field.top + 4, maxHeight: Math.min(LIST_MAX_HEIGHT, above) };
  }
  return { left: field.left, width: field.width, top: field.bottom + 4, maxHeight: Math.min(LIST_MAX_HEIGHT, Math.max(below, 80)) };
}

/**
 * An email field that suggests termag users: the people this browser last
 * shared with (utils/recentPeople.ts) as soon as it has focus, then whoever
 * the server finds for what is typed (GET /api/users/search). A combobox in
 * the RepoPicker's manner: ↑/↓ move, Enter or a click picks, Escape closes
 * the list (and not the dialog around it). Any email can still be typed and
 * submitted; picking one only fills it in. `onChange` gets the name when a
 * suggestion is picked, so the caller can remember it.
 */
export function PersonPicker({
  value,
  onChange,
  autoFocus,
  required,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (email: string, displayName?: string) => void;
  autoFocus?: boolean;
  required?: boolean;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [found, setFound] = useState<{ query: string; people: PersonMatch[] }>({ query: '', people: [] });
  // Read when the list opens, so a share made in another dialog shows up.
  const [recent, setRecent] = useState(() => readRecentPeople(browserStorage()));
  const request = useRef(0);
  const field = useRef<HTMLInputElement>(null);
  const [place, setPlace] = useState<React.CSSProperties | null>(null);
  const listId = useId();
  const optionId = (i: number) => `${listId}-opt-${i}`;
  const q = value.trim();

  useEffect(() => {
    if (q.length < MIN_QUERY) return;
    const id = ++request.current;
    const timer = setTimeout(() => {
      usersApi.search(q)
        // Only the newest question's answer lands: a slow early reply can't replace a later one.
        .then(people => { if (request.current === id) setFound({ query: q, people }); })
        .catch(() => { if (request.current === id) setFound({ query: q, people: [] }); });
    }, PERSON_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q]);

  const options = useMemo(() => {
    const seen = new Set<string>();
    const out: PersonMatch[] = [];
    const add = (p: PersonMatch) => {
      const key = p.email.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(p);
    };
    for (const p of recent) if (personMatches(p, q)) add(p);
    if (q.length >= MIN_QUERY && found.query === q) for (const p of found.people) add(p);
    // What's typed already is the whole answer: no list of one repeating it.
    return out.length === 1 && out[0].email.toLowerCase() === q.toLowerCase() ? [] : out;
  }, [recent, found, q]);

  const showList = open && options.length > 0;
  // Follows the field while the list is up: the dialog's pane scrolls, the window resizes.
  useLayoutEffect(() => {
    if (!showList) return;
    const update = () => { if (field.current) setPlace(listPlacement(field.current.getBoundingClientRect(), window.innerHeight)); };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => { window.removeEventListener('scroll', update, true); window.removeEventListener('resize', update); };
  }, [showList]);
  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => {
    if (showList) document.getElementById(optionId(active))?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showList, active]);

  function openList() {
    setRecent(readRecentPeople(browserStorage()));
    setOpen(true);
  }

  function pick(p: PersonMatch) {
    onChange(p.email, p.displayName || undefined);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) openList();
      else setActive(i => Math.min(i + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) openList();
      else setActive(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && showList && options[active]) {
      // Picks the highlighted person rather than submitting the form.
      e.preventDefault();
      pick(options[active]);
    } else if (e.key === 'Escape' && showList) {
      // preventDefault keeps the dialog open (Dialog.tsx): this Escape closes the list.
      e.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div className="person-picker">
      <input
        ref={field}
        type="email"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList ? optionId(active) : undefined}
        aria-label={ariaLabel}
        autoComplete="off"
        autoFocus={autoFocus}
        required={required}
        placeholder={placeholder}
        value={value}
        onFocus={openList}
        onClick={openList}
        onBlur={() => setOpen(false)}
        onChange={e => { onChange(e.target.value); setOpen(true); }}
        onKeyDown={onKeyDown}
      />
      {showList && createPortal(
        <div className="person-picker-list" id={listId} role="listbox" aria-label="People" style={place ?? undefined}
          // Keeps focus in the field, so its blur does not close the list before a click lands.
          onMouseDown={e => e.preventDefault()}>
          {options.map((p, i) => (
            <div
              key={p.email}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              className={`person-picker-option${i === active ? ' is-active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(p)}
            >
              {p.displayName && <span className="person-picker-name">{p.displayName}</span>}
              <span className="person-picker-email">{p.email}</span>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
