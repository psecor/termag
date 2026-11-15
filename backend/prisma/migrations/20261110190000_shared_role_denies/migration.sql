-- The quarantine deny list on the shared box role (services/boxSharedRole.ts):
-- one row per quarantined instance. Every write of the role's
-- termag-quarantine-deny-instances policy is the whole of this table for the
-- role. releaseAfter: when the entry may go (instance terminated plus the
-- retention); null while the box is held. Additive.
CREATE TABLE "shared_role_denies" (
    "roleName" TEXT NOT NULL,
    "ec2InstanceId" TEXT NOT NULL,
    "boxId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releaseAfter" TIMESTAMP(3),

    CONSTRAINT "shared_role_denies_pkey" PRIMARY KEY ("roleName","ec2InstanceId")
);

CREATE INDEX "shared_role_denies_releaseAfter_idx" ON "shared_role_denies"("releaseAfter");
