// Side-effecting startup step: derive DATABASE_URL from PG_* before any module
// constructs a PrismaClient (they read the env at import time). Import this
// immediately after 'dotenv/config' in index.ts — import order is load-bearing.
import { applyDerivedDatabaseUrl } from './env';

applyDerivedDatabaseUrl(process.env);
