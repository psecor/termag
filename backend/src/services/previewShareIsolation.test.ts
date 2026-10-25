/**
 * Preview shares must never become access to a project: only the guest path reads a share, so a check
 * forgotten elsewhere can't widen it. This holds the code to that: the
 * tables are read in one service, and that service is imported only where
 * the plan says.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { out.push(...sources(full)); continue; }
    if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const files = sources(SRC).map((f) => ({ path: relative(SRC, f), text: readFileSync(f, 'utf8') }));

describe('preview shares stay on the guest path', () => {
  it('only services/previewShares.ts touches the preview share tables', () => {
    const touching = files.filter((f) => /\bprisma\.previewShare(?:Viewer|Event|Settings)?\b|\btx\.previewShare/.test(f.text)).map((f) => f.path);
    expect(touching).toEqual(['services/previewShares.ts']);
  });

  it('the share service is used only by its routes, the browser socket, the two lifecycle hooks, and the link shares\' GitHub half', () => {
    const importing = files.filter((f) => /from '(?:\.\.\/services|\.)\/previewShares'/.test(f.text)).map((f) => f.path).sort();
    expect(importing).toEqual(['routes/browserWs.ts', 'routes/previewShares.ts', 'routes/projects.ts', 'routes/workstreams.ts', 'services/previewShareLinks.ts']);
    // Phase 2's GitHub half (the comment, the sweep) is reached from the share routes and index.ts's startup only.
    const links = files.filter((f) => /from '(?:\.\.\/services|\.\/services|\.)\/previewShareLinks'/.test(f.text)).map((f) => f.path).sort();
    expect(links).toEqual(['index.ts', 'routes/previewShares.ts']);
    // The lifecycle hooks only end shares; they never read one as access.
    for (const hook of ['routes/projects.ts', 'routes/workstreams.ts']) {
      const text = files.find((f) => f.path === hook)!.text;
      expect(text.match(/import \{([^}]*)\} from '\.\.\/services\/previewShares'/)?.[1].trim(), hook).toBe('endPreviewShares');
    }
  });

  it('no session, terminal, chat, status or MetaTerm access check mentions them', () => {
    // workstreamPrs.ts only announces a PR (onPrCreated); the share routes listen to it.
    for (const path of ['services/sessionAccess.ts', 'services/statusAudience.ts', 'routes/chat.ts', 'routes/sessions.ts', 'routes/sharing.ts', 'routes/status.ts', 'services/workstreamPrs.ts']) {
      const f = files.find((x) => x.path === path);
      expect(f, path).toBeDefined();
      expect(/previewShare|PreviewShare|preview-share/.test(f!.text), path).toBe(false);
    }
    // The terminal socket lives in index.ts, which mounts the share routes and nothing more.
    const index = files.find((f) => f.path === 'index.ts')!.text;
    const code = index.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/'[^'\n]*'/g, "''");
    const used = new Set(code.match(/\w*[pP]review[sS]hare\w*|previewLink\w*/g) ?? []);
    expect([...used].sort()).toEqual([
      'defaultPreviewShareRouteDeps', 'installAutoPreviewShares', 'installPreviewShareLinkHooks', 'previewLinkRouter', 'previewSharesRouter', 'startPreviewShareSweep', 'stopPreviewShareSweep',
    ]);
  });
});
