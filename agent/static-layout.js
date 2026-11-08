'use strict';

// The static layout: a box made from an environment keeps each of
// its repositories at ~/<STATIC_ROOT>/<name>: ~/code, since the box image already has ~/src/termag, ~/src/webapp
// and ~/src/dev. One constant here and one in backend/src/services/staticLayout.ts (STATIC_LAYOUT_ROOT).
const STATIC_ROOT = 'code';
// One directory under the root: a repository's name, or the definition's `path` for it.
const STATIC_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

module.exports = { STATIC_ROOT, STATIC_NAME_RE };
