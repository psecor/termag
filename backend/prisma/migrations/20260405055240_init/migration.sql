-- CreateEnum
CREATE TYPE "WorkflowType" AS ENUM ('agent', 'data');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "googleId" TEXT NOT NULL,
    "googleEmail" TEXT NOT NULL,
    "unixUsername" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflows" (
    "id" TEXT NOT NULL,
    "type" "WorkflowType" NOT NULL,
    "server" TEXT NOT NULL DEFAULT 'localhost',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "projectId" TEXT NOT NULL,

    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_terminals" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "server" TEXT NOT NULL DEFAULT 'localhost',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,

    CONSTRAINT "work_terminals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "browser_tabs" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "favIcon" TEXT,
    "windowId" INTEGER,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "projectId" TEXT NOT NULL,

    CONSTRAINT "browser_tabs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "relay_snapshots" (
    "id" TEXT NOT NULL,
    "relayToken" TEXT NOT NULL,
    "snapshotAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "windows" JSONB NOT NULL,

    CONSTRAINT "relay_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_googleId_key" ON "users"("googleId");

-- CreateIndex
CREATE UNIQUE INDEX "users_googleEmail_key" ON "users"("googleEmail");

-- CreateIndex
CREATE UNIQUE INDEX "users_unixUsername_key" ON "users"("unixUsername");

-- CreateIndex
CREATE INDEX "projects_userId_archived_idx" ON "projects"("userId", "archived");

-- CreateIndex
CREATE UNIQUE INDEX "projects_userId_name_key" ON "projects"("userId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "workflows_projectId_type_key" ON "workflows"("projectId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "work_terminals_userId_name_key" ON "work_terminals"("userId", "name");

-- CreateIndex
CREATE INDEX "browser_tabs_projectId_idx" ON "browser_tabs"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "relay_snapshots_relayToken_key" ON "relay_snapshots"("relayToken");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_terminals" ADD CONSTRAINT "work_terminals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "browser_tabs" ADD CONSTRAINT "browser_tabs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
