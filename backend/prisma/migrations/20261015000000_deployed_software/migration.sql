-- CreateTable
CREATE TABLE "host_software" (
    "hostKey" TEXT NOT NULL,
    "hostKind" TEXT NOT NULL,
    "component" TEXT NOT NULL,
    "version" TEXT,
    "raw" TEXT,
    "path" TEXT,
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "host_software_pkey" PRIMARY KEY ("hostKey","component")
);

-- CreateTable
CREATE TABLE "software_changes" (
    "id" TEXT NOT NULL,
    "hostKey" TEXT NOT NULL,
    "component" TEXT NOT NULL,
    "from" TEXT,
    "to" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "software_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_versions" (
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_versions_pkey" PRIMARY KEY ("userId","kind")
);

-- CreateIndex
CREATE INDEX "host_software_component_idx" ON "host_software"("component");

-- CreateIndex
CREATE INDEX "software_changes_component_at_idx" ON "software_changes"("component", "at");

-- CreateIndex
CREATE INDEX "software_changes_hostKey_at_idx" ON "software_changes"("hostKey", "at");

