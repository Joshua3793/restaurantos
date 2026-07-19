-- Perf: index the movement-history scans behind theoretical-stock (getTheoreticalStockMap).
CREATE INDEX IF NOT EXISTS "PrepLog_revenueCenterId_logDate_idx" ON "PrepLog"("revenueCenterId", "logDate");
CREATE INDEX IF NOT EXISTS "WastageLog_revenueCenterId_date_idx" ON "WastageLog"("revenueCenterId", "date");
CREATE INDEX IF NOT EXISTS "StockTransfer_createdAt_idx" ON "StockTransfer"("createdAt");
