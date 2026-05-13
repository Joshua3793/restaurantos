-- PriceAlert and RecipeAlert tables for invoice approval notifications.
-- Tables were created via db push; this migration records them for deploy tracking.
-- Also adds approvedAt to InvoiceSession (written by the approve route).

-- ── InvoiceSession.approvedAt ─────────────────────────────────────────────────
ALTER TABLE "InvoiceSession" ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMP(3);

-- ── PriceAlert ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "PriceAlert" (
  "id"              TEXT NOT NULL,
  "sessionId"       TEXT NOT NULL,
  "inventoryItemId" TEXT NOT NULL,
  "previousPrice"   DECIMAL(65,30) NOT NULL,
  "newPrice"        DECIMAL(65,30) NOT NULL,
  "changePct"       DECIMAL(65,30) NOT NULL,
  "direction"       TEXT NOT NULL,
  "acknowledged"    BOOLEAN NOT NULL DEFAULT false,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PriceAlert_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PriceAlert_sessionId_fkey'
  ) THEN
    ALTER TABLE "PriceAlert"
      ADD CONSTRAINT "PriceAlert_sessionId_fkey"
        FOREIGN KEY ("sessionId") REFERENCES "InvoiceSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PriceAlert_inventoryItemId_fkey'
  ) THEN
    ALTER TABLE "PriceAlert"
      ADD CONSTRAINT "PriceAlert_inventoryItemId_fkey"
        FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ── RecipeAlert ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "RecipeAlert" (
  "id"                TEXT NOT NULL,
  "sessionId"         TEXT NOT NULL,
  "recipeId"          TEXT NOT NULL,
  "previousCost"      DECIMAL(65,30) NOT NULL,
  "newCost"           DECIMAL(65,30) NOT NULL,
  "changePct"         DECIMAL(65,30) NOT NULL,
  "newFoodCostPct"    DECIMAL(65,30),
  "exceededThreshold" BOOLEAN NOT NULL DEFAULT false,
  "acknowledged"      BOOLEAN NOT NULL DEFAULT false,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RecipeAlert_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'RecipeAlert_sessionId_fkey'
  ) THEN
    ALTER TABLE "RecipeAlert"
      ADD CONSTRAINT "RecipeAlert_sessionId_fkey"
        FOREIGN KEY ("sessionId") REFERENCES "InvoiceSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'RecipeAlert_recipeId_fkey'
  ) THEN
    ALTER TABLE "RecipeAlert"
      ADD CONSTRAINT "RecipeAlert_recipeId_fkey"
        FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
