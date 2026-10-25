-- Phase 2, 4c: the path filter for automatic PR link shares.
ALTER TABLE "preview_share_settings" ADD COLUMN "pathFilter" TEXT[] DEFAULT ARRAY[]::TEXT[];
