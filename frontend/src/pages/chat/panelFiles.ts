// Files open in the side panel (project-files-enabled): inside the panel, the Files tool and its explorer
// open a picked file as one of the place's file tabs (chat/openItems.ts openInPanel) instead of a file page in the
// main panel, and its Open list shows a file tab rather than going to it. SidePanel.tsx provides it; absent (the flag
// off, or outside the panel), files open in the main panel as before.
import { createContext, useContext } from 'react';

export interface PanelFilesApi {
  /** The side panel's place (chat/sidePanel.ts sidePanelPlace), which its file tabs are open beside. */
  place: string;
  /** Opens `ref` as a file tab here, or shows its tab if it has one. */
  open: (ref: { space: string; path: string }) => void;
  /** Shows file tab `id`, one of this place's. */
  show: (id: string) => void;
}

export const PanelFilesContext = createContext<PanelFilesApi | null>(null);

export function usePanelFiles(): PanelFilesApi | null {
  return useContext(PanelFilesContext);
}
