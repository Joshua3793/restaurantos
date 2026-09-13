-- InventorySnapshot.source — where a snapshot row's quantity came from.
--
-- Finalize used to write one row per count line, whether or not the line was
-- counted: a blank line was snapshotted at its theoretical (expected) quantity
-- and folded into CountSession.totalCountedValue, indistinguishable from a real
-- count. The 31 Jul 2026 "prep count" reported $26,966.61 of which $23,041 was
-- 360 lines nobody counted.
--
-- 1. Add the flag (default COUNTED so the writer never has to think about it).
-- 2. Backfill every existing row from its CountLine, using the same rule as
--    src/lib/count-snapshot-source.ts snapshotSourceOf():
--      skipped              → SKIPPED
--      countedQty IS NULL   → THEORETICAL
--      carriedForward       → CARRIED
--      else                 → COUNTED
-- 3. Restate every finalized session's totalCountedValue as the sum of its
--    observed (COUNTED + CARRIED) rows only. The theoretical rows stay on disk
--    (flagged) so per-session history is untouched; only the headline changes.

ALTER TABLE "InventorySnapshot" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'COUNTED';

UPDATE "InventorySnapshot" s
SET "source" = CASE
  WHEN l."skipped" THEN 'SKIPPED'
  WHEN l."countedQty" IS NULL THEN 'THEORETICAL'
  WHEN l."carriedForward" THEN 'CARRIED'
  ELSE 'COUNTED'
END
FROM "CountLine" l
WHERE l."sessionId" = s."sessionId"
  AND l."inventoryItemId" = s."inventoryItemId";

UPDATE "CountSession" c
SET "totalCountedValue" = COALESCE((
  SELECT SUM(s."totalValue")
  FROM "InventorySnapshot" s
  WHERE s."sessionId" = c."id"
    AND s."source" IN ('COUNTED', 'CARRIED')
), 0)
WHERE c."status" = 'FINALIZED';

CREATE INDEX "InventorySnapshot_inventoryItemId_source_idx" ON "InventorySnapshot"("inventoryItemId", "source");
