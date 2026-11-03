-- AlterTable: which published AMI a managed box launches from. Existing rows
-- are all the standard Component=box bake, so default to 'full'.
-- flavor='minimal' boxes launch from Component=box-min and are bootstrapped
-- by their owner instead of the bake.
ALTER TABLE "instances" ADD COLUMN "flavor" TEXT NOT NULL DEFAULT 'full';
