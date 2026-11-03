// Generative UI's draw limits that more than the spec reader needs (the
// render-time check in kit.tsx reads them too). No imports, so anything may
// take them without a cycle.

/**
 * The most items a repeated list may have. Checked when the spec is read, and
 * again on every render (kit.tsx guardedBy), since a press can set state.
 */
export const REPEAT_MAX_ITEMS = 100;
/** The prop readSpec gives a repeated element: its state array's path, for the render-time check. */
export const REPEAT_PATH_PROP = '__repeat';
