-- Require a revenue center on every movement (rows backfilled to the default RC first).
-- Hand-trimmed from `prisma migrate diff`, which also surfaced UNRELATED pre-existing
-- drift (Toast tables, SalesEntry.source, RevenueCenter.toastGuid). Those drops are
-- intentionally excluded — this migration only adds the three NOT NULL constraints.
ALTER TABLE "PrepLog"    ALTER COLUMN "revenueCenterId" SET NOT NULL;
ALTER TABLE "SalesEntry" ALTER COLUMN "revenueCenterId" SET NOT NULL;
ALTER TABLE "WastageLog" ALTER COLUMN "revenueCenterId" SET NOT NULL;
