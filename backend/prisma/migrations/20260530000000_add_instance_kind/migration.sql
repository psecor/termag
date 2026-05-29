-- AlterTable: distinguish self-managed (BYO) boxes from orchestrator-provisioned
-- EC2 boxes. Existing rows are all EC2-provisioned, so default to 'ec2'.
-- kind='external' boxes carry an instance-bound token the user runs themselves
-- and never touch AWS.
ALTER TABLE "instances" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'ec2';
