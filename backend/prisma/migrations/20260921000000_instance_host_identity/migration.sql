-- AlterTable: host identity reported by the agent's `hello` on connect --
-- the unix user the agent runs as and that user's home directory. Both
-- nullable and unbackfilled: a pre-`hello` agent leaves them null and
-- readers fall back to /home/<unixUsername>.
ALTER TABLE "instances" ADD COLUMN "hostUnixUser" TEXT;
ALTER TABLE "instances" ADD COLUMN "hostHome" TEXT;
