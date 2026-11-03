import { useTheme } from '../theme/ThemeProvider';
import { stoppedToggleLabel } from '../utils/stoppedBoxGroups';

/**
 * "Show stopped (N)" at the foot of the full UI's Projects list. The choice
 * is the user's `sidebarShowStopped` theme key, so it follows them across
 * browsers like the sidebar's other view settings.
 */
export function StoppedBoxesToggle({ boxCount, projectCount }: { boxCount: number; projectCount: number }) {
  const { theme, saved, preview, save } = useTheme();
  const shown = theme.sidebarShowStopped;
  const toggle = () => {
    const next = { ...saved, sidebarShowStopped: !shown };
    // Shown at once; the save ends the preview when it settles, so a failed one flips back.
    preview(next);
    save(next).catch(() => { /* the toggle flips back */ });
  };
  return (
    <li className="project-stopped-toggle">
      <button
        type="button"
        className="btn-ghost btn-select-toggle"
        aria-pressed={shown}
        onClick={toggle}
        title={`${projectCount} ${projectCount === 1 ? 'project' : 'projects'} on ${boxCount} stopped ${boxCount === 1 ? 'box' : 'boxes'}. `
          + 'Boxes lists and starts them all; an open project, an error or unpushed work always stays listed.'}
      >{stoppedToggleLabel(shown, boxCount)}</button>
    </li>
  );
}
