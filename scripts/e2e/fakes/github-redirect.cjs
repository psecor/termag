// Preloaded into the e2e backend (NODE_OPTIONS=--require) when
// E2E_FAKE_GITHUB=1: global fetch calls to https://api.github.com go to the
// loopback stub at E2E_GITHUB_URL, and to https://github.com under its
// /_github.com prefix (git smart-HTTP). Only fetch is redirected.
const target = process.env.E2E_GITHUB_URL;
const realFetch = globalThis.fetch;
if (target && realFetch) {
  const ROUTES = [['https://api.github.com', target], ['https://github.com', `${target}/_github.com`]];
  const rewrite = (url) => {
    for (const [prefix, to] of ROUTES) {
      if (url === prefix || url.startsWith(`${prefix}/`)) return to + url.slice(prefix.length);
    }
    return null;
  };
  globalThis.fetch = function fetch(input, init) {
    if (typeof input === 'string' || input instanceof URL) {
      const to = rewrite(String(input));
      if (to) return realFetch(to, init);
    } else if (input && typeof input.url === 'string') {
      const to = rewrite(input.url);
      if (to) return realFetch(new Request(to, input), init);
    }
    return realFetch(input, init);
  };
}
