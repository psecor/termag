-- CreateTable
CREATE TABLE "instances" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ec2InstanceId" TEXT,
    "region" TEXT,
    "hostname" TEXT,
    "status" TEXT NOT NULL DEFAULT 'provisioning',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "terminatedAt" TIMESTAMP(3),
    "lastConnectedAt" TIMESTAMP(3),

    CONSTRAINT "instances_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "instanceId" TEXT;

-- AlterTable
ALTER TABLE "agent_tokens" ADD COLUMN "instanceId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "instances_ec2InstanceId_key" ON "instances"("ec2InstanceId");

-- CreateIndex
CREATE UNIQUE INDEX "instances_userId_name_key" ON "instances"("userId", "name");

-- CreateIndex
CREATE INDEX "instances_userId_status_idx" ON "instances"("userId", "status");

-- CreateIndex
CREATE INDEX "projects_instanceId_idx" ON "projects"("instanceId");

-- CreateIndex
CREATE INDEX "agent_tokens_instanceId_idx" ON "agent_tokens"("instanceId");

-- AddForeignKey
ALTER TABLE "instances" ADD CONSTRAINT "instances_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tokens" ADD CONSTRAINT "agent_tokens_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
