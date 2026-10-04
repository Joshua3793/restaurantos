-- ItemRemeasure: the record of one "change how it's measured" run — the before-values
-- of every row it restated (src/lib/remeasure-exec.ts), replayed backwards by undo.
CREATE TABLE "ItemRemeasure" (
  "id"        TEXT NOT NULL,
  "itemId"    TEXT NOT NULL,
  "changedBy" TEXT NOT NULL,
  "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "undoneAt"  TIMESTAMP(3),
  "manifest"  JSONB NOT NULL,
  CONSTRAINT "ItemRemeasure_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ItemRemeasure_itemId_idx" ON "ItemRemeasure"("itemId");
