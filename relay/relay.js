#!/usr/bin/env node
/**
 * termag Chrome relay
 *
 * Runs on your local machine. Polls Chrome's remote debugging API and pushes
 * tab snapshots to the termag server so you can sync browser tabs to projects.
 *
 * Setup:
 *   1. Launch Chrome with: --remote-debugging-port=9222
 *      macOS alias: alias chrome='open -a "Google Chrome" --args --remote-debugging-port=9222'
 *      Linux alias: alias chrome='google-chrome --remote-debugging-port=9222'
 *   2. cp relay.config.example.json relay.config.json
 *   3. Fill in termag_url and relay_token
 *   4. npm install && node relay.js
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, 'relay.config.json');
if (!fs.existsSync(configPath)) {
  console.error('relay.config.json not found. Copy relay.config.example.json and fill it in.');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const { termag_url, relay_token, chrome_debug_port = 9222, push_interval_seconds = 30 } = config;

if (!termag_url || !relay_token) {
  console.error('termag_url and relay_token are required in relay.config.json');
  process.exit(1);
}

const CDP_URL = `http://localhost:${chrome_debug_port}/json/list`;
const PUSH_URL = `${termag_url}/api/browser/sync`;

async function fetchChromeTabs() {
  return new Promise((resolve, reject) => {
    http.get(CDP_URL, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('Failed to parse Chrome CDP response'));
        }
      });
    }).on('error', reject);
  });
}

function groupByWindow(tabs) {
  const windows = new Map();
  for (const tab of tabs) {
    if (tab.type !== 'page') continue; // skip devtools, extensions, etc.
    const wid = tab.windowId ?? 0;
    if (!windows.has(wid)) windows.set(wid, []);
    windows.get(wid).push({
      url: tab.url,
      title: tab.title,
      favIcon: tab.favIconUrl,
    });
  }
  return Array.from(windows.entries()).map(([windowId, tabs]) => ({ windowId, tabs }));
}

async function pushSnapshot(windows) {
  const body = JSON.stringify({ windows });
  const url = new URL(PUSH_URL);
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Authorization': `Bearer ${relay_token}`,
        },
      },
      (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200 || res.statusCode === 201) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`Server returned ${res.statusCode}: ${data}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sync() {
  try {
    const tabs = await fetchChromeTabs();
    const windows = groupByWindow(tabs);
    const result = await pushSnapshot(windows);
    const total = windows.reduce((s, w) => s + w.tabs.length, 0);
    console.log(`[${new Date().toISOString()}] Synced ${windows.length} window(s), ${total} tab(s)`);
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.warn(`[${new Date().toISOString()}] Chrome not reachable on port ${chrome_debug_port} — is it running with --remote-debugging-port=${chrome_debug_port}?`);
    } else {
      console.error(`[${new Date().toISOString()}] Sync error:`, err.message);
    }
  }
}

console.log(`termag relay starting — pushing to ${PUSH_URL} every ${push_interval_seconds}s`);
sync(); // immediate first push
setInterval(sync, push_interval_seconds * 1000);
