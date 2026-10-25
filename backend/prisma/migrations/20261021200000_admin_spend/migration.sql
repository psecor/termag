-- Admin spend model: settings, dated model prices, cost pools.
CREATE TABLE "spend_settings" (
    "id" TEXT NOT NULL DEFAULT 'settings',
    "loadedCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 500000,
    "orgHeadcount" INTEGER NOT NULL DEFAULT 626,
    "modelMix" JSONB NOT NULL DEFAULT '{}',
    "seeded" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spend_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "model_prices" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT '*',
    "effectiveFrom" TEXT NOT NULL,
    "input" DOUBLE PRECISION NOT NULL,
    "output" DOUBLE PRECISION NOT NULL,
    "cacheRead" DOUBLE PRECISION NOT NULL,
    "cacheWrite" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_prices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "model_prices_provider_model_effectiveFrom_key" ON "model_prices"("provider", "model", "effectiveFrom");

CREATE TABLE "spend_pools" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "providers" TEXT[],
    "annualUsd" DOUBLE PRECISION,
    "boxes" INTEGER,
    "boxCostUsd" DOUBLE PRECISION,
    "usersPerBox" INTEGER,
    "share" TEXT NOT NULL DEFAULT 'proportional',
    "shareValue" DOUBLE PRECISION,
    "populationLabel" TEXT,
    "populationSize" INTEGER,
    "allocation" TEXT NOT NULL DEFAULT 'even',
    "startDate" TEXT,
    "endDate" TEXT,
    "note" TEXT,
    "sort" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spend_pools_pkey" PRIMARY KEY ("id")
);
