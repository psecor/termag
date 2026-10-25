-- Simple-UI chat trust (services/chatTrust.ts): when the owner trusted a
-- repository outside the trusted GitHub owners, so its chat runs tools
-- without asking. Additive only.

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "chatTrustedAt" TIMESTAMP(3);
