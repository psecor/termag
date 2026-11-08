/**
 * The preview audience core (services/previewAudience.ts) and the link
 * delivery's own tables must never become access to a project: a preview
 * audience lets its viewers see a delivery, nothing else (as previewShareIsolation.test.ts holds preview
 * shares). This holds the code to that: each set of tables is touched through
 * Prisma in one service, and those services are imported only where listed.
 * A new importer or a new file touching the tables is a decision, made here.
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
const touching = (re: RegExp) => files.filter((f) => re.test(f.text)).map((f) => f.path).sort();
const importing = (module: string) => files
  .filter((f) => new RegExp(`from '(?:\\.\\./services|\\./services|\\.)/${module}'`).test(f.text))
  .map((f) => f.path).sort();

describe('the preview audience core and the link tables stay where they belong', () => {
  it('only services/previewAudience.ts touches the core tables, through any client', () => {
    expect(touching(/\.previewAudience(?:Grantee|Viewer|Event)?\s*\./)).toEqual(['services/previewAudience.ts']);
  });

  it('only services/previewLinks.ts touches the link tables (links, names, codes, sessions, requests), and previewLinkConfirmations.ts its confirms', () => {
    // PR 2 (#1180), each with its reason:
    // - previewHostStore.ts: the preview host and the landing page resolve a name to its link, and keep the
    //   one-time codes and the viewers' sessions, which are the link delivery's own tables;
    // - previewLinkSweep.ts: the minute sweep finds expired and box-gone links (their ends go through the
    //   core's endPreviewAudience) and deletes lapsed names, expired codes, dead sessions and stale requests.
    // Row 2b (on #1180):
    // - previewLinkAdmin.ts: an admin ends one link (SR15), so it finds that link by id or by the name serving it;
    //   the end itself goes through the core's endPreviewAudience.
    expect(touching(/\.previewLink(?:Name|Code|Session|Request)?\s*\./)).toEqual(['services/previewHostStore.ts', 'services/previewLinkAdmin.ts', 'services/previewLinkSweep.ts', 'services/previewLinks.ts']);
    // previewLinkConfirmations.ts: the box-made confirms (SR5), its own table only.
    expect(touching(/\.previewLinkConfirmation\s*\./)).toEqual(['services/previewLinkConfirmations.ts']);
  });

  it('the core is used only by the link delivery, its rules, and the two lifecycle hooks', () => {
    // PR 2 (#1180): the host store reads a viewer's standing, records an open and writes events through the
    // core's own functions (audienceStandingOf, audienceViewerSeen, noteAudienceViewer, prismaAudienceOps);
    // the sweep ends audiences with endPreviewAudience; row 2b's admin end-link (previewLinkAdmin.ts) does too.
    expect(importing('previewAudience')).toEqual([
      'routes/projects.ts', 'routes/workstreams.ts',
      'services/previewHostStore.ts', 'services/previewLinkAccess.ts', 'services/previewLinkAdmin.ts', 'services/previewLinkConfirmations.ts', 'services/previewLinkRules.ts', 'services/previewLinkSweep.ts', 'services/previewLinks.ts', 'services/previewLinksTestStore.ts',
    ]);
    // The lifecycle hooks only end audiences; they never read one as access.
    for (const hook of ['routes/projects.ts', 'routes/workstreams.ts']) {
      const text = files.find((f) => f.path === hook)!.text;
      expect(text.match(/import \{([^}]*)\} from '\.\.\/services\/previewAudience'/)?.[1].trim(), hook).toBe('endPreviewAudiences');
    }
    // The rules take kinds and policies, never the tables' Prisma client.
    for (const pure of ['services/previewLinkAccess.ts', 'services/previewLinkRules.ts']) {
      const text = files.find((f) => f.path === pure)!.text;
      expect(text, pure).not.toMatch(/prismaAudienceOps|audienceStandingOf|noteAudienceViewer|from '\.\.\/db'/);
    }
  });

  it('the link service is used only by its routes and index.ts', () => {
    // PR 2 (#1180): its host store and the test store take the PreviewLinkRow type, nothing else.
    expect(importing('previewLinks')).toEqual([
      'index.ts', 'routes/cliPreviewLinksPrisma.ts', 'routes/previewLinks.ts', 'services/previewHostStore.ts', 'services/previewHostTestStore.ts', 'services/previewLinkConfirmations.ts', 'services/previewLinksTestStore.ts',
    ]);
    for (const typeOnly of ['services/previewHostStore.ts', 'services/previewHostTestStore.ts']) {
      expect(files.find((f) => f.path === typeOnly)!.text, typeOnly).toMatch(/import type \{[^}]*\} from '\.\/previewLinks'/);
    }
    // The confirms (SR5) are reached from the CLI routes, the confirm page and index.ts only.
    expect(importing('previewLinkConfirmations')).toEqual(['index.ts', 'routes/cliPreviewLinksPrisma.ts', 'routes/previewLinkConfirm.ts', 'services/previewLinksTestStore.ts']);
  });

  it('no session, terminal, chat, status or MetaTerm access check mentions them', () => {
    for (const path of ['services/sessionAccess.ts', 'services/statusAudience.ts', 'routes/chat.ts', 'routes/sessions.ts', 'routes/sharing.ts', 'routes/status.ts', 'middleware/auth.ts']) {
      const f = files.find((x) => x.path === path);
      expect(f, path).toBeDefined();
      expect(/previewAudience|PreviewAudience|previewLink|PreviewLink/.test(f!.text), path).toBe(false);
    }
  });
});
