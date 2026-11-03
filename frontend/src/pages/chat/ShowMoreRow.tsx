// The row under a list that shows part of itself (chat/incrementalList.ts):
// "Show more" while rows are hidden, nothing once every row shows (or when
// the list fits). The click that shows the last of them takes the row away,
// so focus goes on to the last row it revealed rather than to the page.
import React, { useRef } from 'react';
import { flushSync } from 'react-dom';
import type { IncrementalList } from '../../chat/incrementalList';

export function ShowMoreRow({ list, name }: { list: Pick<IncrementalList<unknown>, 'hidden' | 'step' | 'showMore'>; name: string }) {
  const li = useRef<HTMLLIElement>(null);
  if (list.hidden <= 0) return null;
  const onClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    const last = list.hidden <= list.step;
    const focused = document.activeElement === e.currentTarget;
    const ul = li.current?.parentElement;
    if (!last || !focused || !ul) { list.showMore(); return; }
    // Render now, without this row, then focus the last row of the list.
    flushSync(list.showMore);
    // The row's own link or button first (a tab before its ⋮).
    const rows = ul.querySelectorAll<HTMLElement>(':scope > li');
    rows[rows.length - 1]?.querySelector<HTMLElement>('a[href], button')?.focus();
  };
  return (
    <li ref={li} className="chat-group-more-li">
      <button type="button" className="chat-group-more" onClick={onClick} data-tip={`${list.hidden} more in ${name}`}>
        Show more
        <span className="chat-sr">: {Math.min(list.step, list.hidden)} of {list.hidden} more in {name}</span>
      </button>
    </li>
  );
}
