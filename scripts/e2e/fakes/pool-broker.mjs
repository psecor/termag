#!/usr/bin/env node
// A stand-in for the GitHub broker's git front, for the environment pool's demo on the e2e stack
// (docs/e2e-stack.md, E2E_POOL_BROKER_CA): https on 127.0.0.1:443 (`localhost`, as GITHUB_BROKER_URL must be a
// bare host on 443), forwarding git's smart-HTTP to the GitHub stub's /_github.com/. It checks nothing: the broker's
// real check (services/githubAuthz.ts, behind Envoy) is E2E_CLAUDE_GATEWAY's. It logs each request, saying only
// whether it carried credentials, never what they were.
//
//   node pool-broker.mjs <cert.pem> <key.pem> <stub base, e.g. http://127.0.0.1:4580> <log file>
import { createServer } from 'node:https';
import { readFileSync, appendFileSync } from 'node:fs';

const [cert, key, stub, logFile] = process.argv.slice(2);
if (!cert || !key || !stub || !logFile) {
  console.error('usage: pool-broker.mjs <cert.pem> <key.pem> <stub base> <log file>');
  process.exit(2);
}

const log = (line) => appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);

createServer({ cert: readFileSync(cert), key: readFileSync(key) }, async (req, res) => {
  const auth = req.headers.authorization ? `auth=${req.headers.authorization.split(' ')[0]}` : 'auth=none';
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.authorization;
  delete headers['content-length'];
  try {
    const upstream = await fetch(`${stub}/_github.com${req.url}`, {
      method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
    });
    log(`${req.method} ${req.url} ${auth} -> ${upstream.status}`);
    res.writeHead(upstream.status, Object.fromEntries(upstream.headers));
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    log(`${req.method} ${req.url} ${auth} -> 502 (${err.message})`);
    res.writeHead(502).end(String(err));
  }
}).listen(443, '127.0.0.1', () => log('pool broker stand-in on https://localhost:443'));
