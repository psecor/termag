#!/usr/bin/env node
// Stand-in for `claude auth` in the e2e stack. Matches the Claude Code 2.1.302
// contract the simple UI depends on: `auth status` prints JSON (exit 0 when
// logged in, 1 when not), and `auth login --claudeai --sso` prints an SSO
// authorize URL and reads one code#state line. The line is never written back.
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = process.env.HOME || homedir();
const claudeDir = join(home, '.claude');
const marker = join(claudeDir, 'signed-in');
const GOOD = process.env.E2E_CLAUDE_LOGIN_CODE || 'e2e-login#e2e-state';
const URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=e2e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user&code_challenge=e2e-challenge&code_challenge_method=S256&state=e2e-state&login_method=sso';

function gateway() {
  if (process.env.CLAUDE_CODE_USE_BEDROCK === '1') return true;
  try {
    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    if (settings && typeof settings.apiKeyHelper === 'string' && settings.apiKeyHelper) return true;
    const env = settings && settings.env;
    if (env && (env.CLAUDE_CODE_USE_BEDROCK === '1' || env.CLAUDE_CODE_USE_BEDROCK === 1)) return true;
  } catch { /* no settings, or not JSON */ }
  return false;
}

function status() {
  if (gateway()) {
    process.stdout.write(`${JSON.stringify({ loggedIn: true, authMethod: 'third_party', apiProvider: 'bedrock', apiKeySource: 'apiKeyHelper' })}\n`);
    process.exit(0);
  }
  if (existsSync(marker)) {
    process.stdout.write(`${JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' })}\n`);
    process.exit(0);
  }
  process.stdout.write(`${JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' })}\n`);
  process.exit(1);
}

function login() {
  if (!process.argv.includes('--sso')) {
    process.stderr.write('sso required\n');
    process.exit(2);
  }
  process.stdout.write('Opening browser to sign in…\n');
  process.stdout.write(`If the browser didn't open, visit: ${URL}\n`);
  process.stdout.write('Paste code here if prompted > ');
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', line => {
    if (line.trim() === GOOD) {
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(marker, 'ok\n', { mode: 0o600 });
      process.stdout.write('Login successful.\n');
      process.exit(0);
    }
    process.stderr.write('Invalid code. Please make sure the full code was copied.\n');
    process.stdout.write('Paste code here if prompted > ');
  });
}

const [cmd, sub] = process.argv.slice(2);
if (cmd === 'auth' && sub === 'status') status();
else if (cmd === 'auth' && sub === 'login') login();
else process.exit(2);
