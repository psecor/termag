-- Instance.iamInstanceProfileName: the per-box instance profile, recorded once
-- it exists. Teardown's completion stamp is guarded on it, so a profile a
-- concurrent launch creates after teardown already looked keeps the row in the
-- teardown sweep. NULL on existing rows: teardown falls back to the
-- deterministic name, as it does for iamRoleName.
ALTER TABLE "instances" ADD COLUMN "iamInstanceProfileName" TEXT;
