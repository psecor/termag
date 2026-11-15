// The browser tab names the open session by its one title (chat/sessionTitle.ts),
// and gives back what it said before when the session closes.
import { useEffect } from 'react';

export function useDocumentTitle(title: string | null): void {
  useEffect(() => {
    if (!title || typeof document === 'undefined') return;
    const before = document.title;
    document.title = title;
    return () => { document.title = before; };
  }, [title]);
}
