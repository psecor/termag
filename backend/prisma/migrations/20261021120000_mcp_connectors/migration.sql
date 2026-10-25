-- CreateTable
CREATE TABLE "mcp_connectors" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "upstream" TEXT NOT NULL,
    "authType" TEXT NOT NULL,
    "headerTemplates" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_connectors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mcp_connectors_userId_name_key" ON "mcp_connectors"("userId", "name");

-- AddForeignKey
ALTER TABLE "mcp_connectors" ADD CONSTRAINT "mcp_connectors_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
