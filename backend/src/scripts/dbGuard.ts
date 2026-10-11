/**
 * `npm run db:guard`: refuse to start termag on the wrong database. The rules
 * are in ../config/dbGuard.ts. Exit 0 to proceed, 3 to refuse, 1 when the RDS
 * probe itself fails.
 *
 * Local mode only reads marker files and never connects. RDS mode (PG_IAM_AUTH)
 * connects through the shared client in ../db, so the probe takes the same
 * IAM-token path as the server.
 */
import 'dotenv/config';
import '../config/bootstrap';
import { existsSync } from 'fs';
import { join } from 'path';
import { iamAuthEnabled } from '../config/env';
import { dataDirFromEnv, guardLocalDatabase, guardRdsDatabase, MARKERS, type GuardMarkers } from '../config/dbGuard';

function readMarkers(dataDir: string): GuardMarkers {
  return {
    movedToRds: existsSync(join(dataDir, MARKERS.movedToRds)),
    allowDockerRollback: existsSync(join(dataDir, MARKERS.allowDockerRollback)),
    allowEmptyDatabase: existsSync(join(dataDir, MARKERS.allowEmptyDatabase)),
  };
}

async function main(): Promise<number> {
  const dataDir = dataDirFromEnv(process.env);
  const markers = readMarkers(dataDir);

  if (!iamAuthEnabled(process.env)) {
    const decision = guardLocalDatabase(markers, dataDir);
    console.log(`[db:guard] ${decision.ok ? 'ok' : 'REFUSED'}: ${decision.message}`);
    return decision.ok ? 0 : 3;
  }

  const { prisma } = await import('../db');
  try {
    const [{ present }] = await prisma.$queryRaw<{ present: boolean }[]>`SELECT to_regclass('public.users') IS NOT NULL AS present`;
    let rows = 0;
    if (present) {
      const [{ n }] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM users`;
      rows = Number(n);
    }
    const decision = guardRdsDatabase(markers, { exists: present, rows }, dataDir);
    console.log(`[db:guard] ${decision.ok ? 'ok' : 'REFUSED'}: ${decision.message}`);
    return decision.ok ? 0 : 3;
  } finally {
    await prisma.$disconnect();
  }
}

main().then(
  code => process.exit(code),
  err => {
    console.error('[db:guard] probe failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
