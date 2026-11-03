-- Box cost, phase 3: the bill per instance per day, and the rates learned from it.
CREATE TABLE "box_billed_days" (
    "id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "ec2InstanceId" TEXT NOT NULL,
    "instanceType" TEXT NOT NULL,
    "hours" DOUBLE PRECISION NOT NULL,
    "usd" DOUBLE PRECISION NOT NULL,
    "estimated" BOOLEAN NOT NULL,
    "pulledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "box_billed_days_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "box_billed_days_ec2InstanceId_day_instanceType_key" ON "box_billed_days"("ec2InstanceId", "day", "instanceType");
CREATE INDEX "box_billed_days_day_idx" ON "box_billed_days"("day");

CREATE TABLE "box_rates" (
    "id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "usd" DOUBLE PRECISION NOT NULL,
    "usage" DOUBLE PRECISION NOT NULL,
    "cost" DOUBLE PRECISION NOT NULL,
    "estimated" BOOLEAN NOT NULL,
    "pulledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "box_rates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "box_rates_key_day_key" ON "box_rates"("key", "day");
CREATE INDEX "box_rates_day_idx" ON "box_rates"("day");
