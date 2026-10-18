#!/usr/bin/env node
// React picks its development or production build from NODE_ENV the first time
// each of its modules is evaluated. The development build records a
// performance.measure() entry for every render, several hundred a second in the
// lobby, and Node never clears its performance timeline, so with NODE_ENV unset
// the TUI grew by tens of MB a minute until the heap ran out. Run the production
// build unless the caller set NODE_ENV to something (empty counts as unset).
//
// The whole TUI is imported while the value is forced, so every React entry
// point (react, react/jsx-runtime, react-reconciler, scheduler) is evaluated
// under it. Importing it does not start it: the environment is put back first,
// so nothing the TUI runs, tmux and attached shells included, inherits the value.
const before = process.env.NODE_ENV;
const forced = !before;
if (forced) process.env.NODE_ENV = 'production';
const { run } = await import('../dist/index.js');
if (forced) {
  if (before === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = before;
}
run();
