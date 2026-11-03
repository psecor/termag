// LaunchPad in termag's colours and fonts (theme.css). Importing this module
// loads the map and LaunchPad's size, spacing and type tokens
// (@launchpad-ui/tokens/index.css, which carries no colours); the class goes on
// the element a LaunchPad surface sits in and on each of its overlays.
import '@launchpad-ui/tokens/index.css';
import './theme.css';

/** The class that maps LaunchPad's --lp-color-* and type tokens to termag's. */
export const LP_THEME = 'lp-theme';
