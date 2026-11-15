-- Environment pools: a pool box runs the warm pool's on-warm hook during its prepare (services/envPool.ts); its
-- scripts' total time, for the prepare event. Deploys sync the schema with `prisma db push`; this file is the record.
ALTER TABLE "instances" ADD COLUMN "onWarmSeconds" INTEGER;
