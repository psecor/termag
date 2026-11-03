/**
 * `npm run automations:move-folders [-- --apply]`: move every automation in a
 * space from its old folder (`automations/<name>`, a chosen one, or the
 * backfilled `automations/<projectId>`) to the fixed
 * `.termag/automations/<automation id>` (services/automations/folderMove.ts).
 * Without --apply it only says what it
 * would do. Prints one JSON line per automation; safe to run again, and a
 * row it skipped keeps working in its old folder until it is moved.
 * Exit 0 when nothing failed or was refused, 1 otherwise.
 */
import 'dotenv/config';
import '../config/bootstrap';
import { prisma } from '../db';
import { LIVE_RUN_STATES } from '../services/automations/store';
import { SETTLE_MS, moveAutomationFolders, type FolderObjects } from '../services/automations/folderMove';
import { objectKey, pathOfKey } from '../services/spaces/spacePaths';
import { spaceObjects } from '../services/spaces/spacesRuntime';
import { prismaSpaceStore } from '../services/spaces/spaceStorePrisma';

async function main(): Promise<number> {
  const apply = process.argv.includes('--apply');
  const objects = await spaceObjects({ kind: 'system', task: 'automation-folder-move' });
  const outcomes = await moveAutomationFolders({
    rows: () => prisma.automation.findMany({
      where: { spaceName: { not: null }, project: { archived: false } },
      select: { id: true, projectId: true, userId: true, spaceName: true, spaceFolder: true },
    }),
    busy: async id => !!(await prisma.automationRun.findFirst({
      where: { automationId: id, OR: [{ state: { in: [...LIVE_RUN_STATES] } }, { finishedAt: { gte: new Date(Date.now() - SETTLE_MS) } }] },
      select: { id: true },
    })),
    space: async name => {
      const space = await prismaSpaceStore.findSpace(name);
      if (!space) return null;
      const key = (path: string) => objectKey(space.id, path);
      const o: FolderObjects = {
        async listPaths(prefix) {
          const paths: string[] = [];
          let cursor: string | null = null;
          do {
            const page = await objects.list(key(prefix), { cursor, delimiter: false });
            for (const f of page.files) { const p = pathOfKey(space.id, f.key); if (p) paths.push(p); }
            cursor = page.nextCursor;
          } while (cursor);
          return paths;
        },
        exists: async path => !!(await objects.head(key(path))),
        copy: (from, to) => objects.copy(key(from), key(to)),
        remove: async paths => (await objects.deleteKeys(paths.map(key))).map(k => pathOfKey(space.id, k) ?? k),
      };
      return { id: space.id, objects: o };
    },
    setFolder: async (id, folder) => { await prisma.automation.update({ where: { id }, data: { spaceFolder: folder } }); },
    event: (spaceId, actorUserId, path, note) => prismaSpaceStore.recordEvent({ spaceId, actorUserId, action: 'file.mv', path, note }),
  }, { apply });
  for (const o of outcomes) console.log(JSON.stringify(o));
  console.error(`${outcomes.length} automation(s) to look at${apply ? '' : ' (dry run; pass --apply to move)'}`);
  return outcomes.some(o => o.result === 'failed' || o.result === 'refused') ? 1 : 0;
}

main().then(code => prisma.$disconnect().then(() => process.exit(code)), err => {
  console.error(err);
  process.exit(1);
});
