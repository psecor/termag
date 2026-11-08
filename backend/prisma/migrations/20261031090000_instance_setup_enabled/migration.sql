-- termag setup on or off for a box, chosen at launch.
ALTER TABLE "instances" ADD COLUMN "setupEnabled" BOOLEAN NOT NULL DEFAULT true;
