-- Where a person's New sessions run when they don't pick a box:
-- 'reuse-first' or 'fresh-first'. NULL means the org
-- default, box-placement-policy. Read and written only under
-- box-placement-enabled. Additive and nullable.
ALTER TABLE "users" ADD COLUMN "boxPlacement" TEXT;
