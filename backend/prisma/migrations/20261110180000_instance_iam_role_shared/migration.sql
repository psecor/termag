-- Whether a box launched with the shared IAM role and instance profile
-- (BOX_SHARED_ROLE_NAME, BOX_INSTANCE_PROFILE_NAME) instead of a role of its
-- own; teardown never deletes a shared one. Existing rows have their own role.
-- Additive, with a default.
ALTER TABLE "instances" ADD COLUMN "iamRoleShared" BOOLEAN NOT NULL DEFAULT false;
