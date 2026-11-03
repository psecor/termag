-- Box cost meter: hourly metered usage per EC2 box, and the meter's tick.
CREATE TABLE "box_usage_hours" (
    "id" TEXT NOT NULL,
    "ec2InstanceId" TEXT NOT NULL,
    "hour" TIMESTAMP(3) NOT NULL,
    "instanceId" TEXT,
    "userId" TEXT,
    "instanceType" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "volumeGb" INTEGER NOT NULL,
    "activeSec" INTEGER NOT NULL DEFAULT 0,
    "idleSec" INTEGER NOT NULL DEFAULT 0,
    "poolSec" INTEGER NOT NULL DEFAULT 0,
    "bootSec" INTEGER NOT NULL DEFAULT 0,
    "orphanSec" INTEGER NOT NULL DEFAULT 0,
    "storageGbSec" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "box_usage_hours_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "box_usage_hours_ec2InstanceId_hour_key" ON "box_usage_hours"("ec2InstanceId", "hour");
CREATE INDEX "box_usage_hours_hour_idx" ON "box_usage_hours"("hour");
CREATE INDEX "box_usage_hours_userId_hour_idx" ON "box_usage_hours"("userId", "hour");

CREATE TABLE "box_meter_state" (
    "id" TEXT NOT NULL DEFAULT 'meter',
    "tickAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "box_meter_state_pkey" PRIMARY KEY ("id")
);
