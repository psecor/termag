-- AlterTable
ALTER TABLE "automations" ADD COLUMN     "notifySlack" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "automation_runs" ADD COLUMN     "commitsAhead" INTEGER,
ADD COLUMN     "pushed" BOOLEAN,
ADD COLUMN     "dirty" BOOLEAN,
ADD COLUMN     "reportedAt" TIMESTAMP(3);
