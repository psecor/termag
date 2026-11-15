import { describe, it, expect } from 'vitest';
import { destructiveStatements } from './schemaDestructive';

describe('destructiveStatements', () => {
  it('flags #1464: a dropped column', () => {
    expect(destructiveStatements('-- AlterTable\nALTER TABLE "instances" DROP COLUMN "poolSetupFailed";\n'))
      .toEqual(['ALTER TABLE "instances" DROP COLUMN "poolSetupFailed"']);
  });

  it('passes additive changes: new tables, nullable or defaulted columns, indexes', () => {
    const sql = `-- AlterTable
ALTER TABLE "users" ADD COLUMN "chatNudgeDismissedAt" TIMESTAMP(3),
ADD COLUMN "flagged" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "things" ("id" TEXT NOT NULL, CONSTRAINT "things_pkey" PRIMARY KEY ("id"));

-- CreateIndex
CREATE UNIQUE INDEX "things_id_key" ON "things"("id");

-- CreateIndex
CREATE INDEX "users_flagged_idx" ON "users"("flagged");

-- AlterEnum
ALTER TYPE "WorkflowType" ADD VALUE 'NEW';
`;
    expect(destructiveStatements(sql)).toEqual([]);
  });

  it('flags drops, type changes, NOT NULL, a required column with no default, and a unique index on an existing table', () => {
    const sql = `/*
  Warnings:
  - You are about to drop the column ...
*/
-- DropTable
DROP TABLE "old";

-- AlterTable
ALTER TABLE "users" DROP COLUMN "a",
ADD COLUMN "b" TEXT NOT NULL,
ALTER COLUMN "c" SET DATA TYPE INTEGER,
ALTER COLUMN "d" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "users_e_key" ON "users"("e");

-- AlterEnum
BEGIN;
CREATE TYPE "WorkflowType_new" AS ENUM ('A');
ALTER TABLE "workflows" ALTER COLUMN "type" TYPE "WorkflowType_new" USING ("type"::text::"WorkflowType_new");
ALTER TYPE "WorkflowType" RENAME TO "WorkflowType_old";
ALTER TYPE "WorkflowType_new" RENAME TO "WorkflowType";
DROP TYPE "WorkflowType_old";
COMMIT;
`;
    expect(destructiveStatements(sql)).toEqual([
      'DROP TABLE "old"',
      'ALTER TABLE "users" DROP COLUMN "a"',
      'ALTER TABLE "users" ADD COLUMN "b" TEXT NOT NULL',
      'ALTER TABLE "users" ALTER COLUMN "c" SET DATA TYPE INTEGER',
      'ALTER TABLE "users" ALTER COLUMN "d" SET NOT NULL',
      'CREATE UNIQUE INDEX "users_e_key" ON "users"("e")',
      'ALTER TABLE "workflows" ALTER COLUMN "type" TYPE "WorkflowType_new" USING ("type"::text::"WorkflowType_new")',
      'DROP TYPE "WorkflowType_old"',
    ]);
  });
});
