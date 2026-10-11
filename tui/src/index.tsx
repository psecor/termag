import { render } from 'ink';
import { resolveConfig } from './config.js';
import { TermagApi } from './api.js';
import { buildRows, indexSessions } from './model.js';
import { listLocalSessions } from './tmux.js';
import { NO_AGENT_GLYPH, STATUS_GLYPH, formatTokens } from './status.js';
import { App } from './ui/App.js';

const USAGE = `termag tui — terminal UI for termag

usage:
  termag tui            open the lobby (interactive)
  termag tui ls         print the project / session list once and exit
  termag tui --help

\`termag tui\` starts this program (termag-tui) signed in with your \`termag login\`,
or on a box with the box's own credentials. Run directly, it needs TERMAG_URL and
TERMAG_TOKEN. Settings (returnKey) live in ~/.config/termag/tui.json.
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(USAGE); return; }

  const config = resolveConfig();
  // Read once; tmux and anything else this process starts must not inherit it.
  delete process.env.TERMAG_TOKEN;
  delete process.env.TERMAG_REFRESH_TOKEN;

  if (argv[0] === 'ls') {
    const api = new TermagApi(config.url, config.token, config.refresh);
    const [projects, sessions, local] = await Promise.all([api.listProjects(), api.listSessions(), listLocalSessions()]);
    const map = indexSessions(sessions);
    const me = sessions.find(s => s.access === 'owner')?.owner ?? '';
    const filter = argv.slice(1).join(' ');
    for (const r of buildRows(projects, map, { filter, localSessions: local, me })) {
      if (r.kind === 'group') { process.stdout.write(`\n[${r.label}] (${r.count})\n`); continue; }
      const glyph = r.status === null ? NO_AGENT_GLYPH : STATUS_GLYPH[r.status];
      if (r.kind === 'project') {
        const b = r.badges;
        const extras = [
          r.workstreamCount > 1 ? `↳${r.workstreamCount}` : '',
          b.provider ?? '',
          b.rateLimited ? 'RATE-LIMITED' : b.contextTokens != null ? `ctx ${formatTokens(b.contextTokens)}` : '',
          r.local ? 'local' : '',
          r.project.role === 'collaborator' ? `owner=${r.project.ownerUsername}` : '',
        ].filter(Boolean).join('  ');
        process.stdout.write(`${r.project.pinned ? '★' : ' '} ${glyph} ${r.project.name.padEnd(28)} ${(r.status ?? '—').padEnd(12)} ${extras}\n`);
      } else {
        process.stdout.write(`      ↳ ${glyph} ${r.workstream.name.padEnd(24)} ${(r.status ?? '—').padEnd(12)} ${r.workstream.branch}\n`);
      }
    }
    return;
  }

  if (argv.length) {
    process.stderr.write(`termag tui: unknown command "${argv[0]}"\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('termag tui: the lobby needs a TTY; try `termag tui ls`\n');
    process.exitCode = 2;
    return;
  }

  const app = render(<App config={config} />, { alternateScreen: true, exitOnCtrlC: true });
  await app.waitUntilExit();
}

main().catch((err: unknown) => {
  process.stderr.write(`termag tui: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
