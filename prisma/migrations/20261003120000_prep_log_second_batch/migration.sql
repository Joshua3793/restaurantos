-- An item can be made more than once a day: once the morning batch is done, the
-- chef can add it again and the new job gets its own row. The old one-row-per-day
-- rule becomes one OPEN row per day — finished rows can stack up.
DROP INDEX IF EXISTS "PrepLog_prepItemId_logDate_key";
CREATE INDEX IF NOT EXISTS "PrepLog_prepItemId_logDate_idx" ON "PrepLog"("prepItemId", "logDate");
-- Prisma cannot model a partial unique index, so this is not in schema.prisma.
CREATE UNIQUE INDEX IF NOT EXISTS "PrepLog_one_open_per_item_day"
  ON "PrepLog" ("prepItemId", "logDate")
  WHERE "status" IN ('NOT_STARTED', 'IN_PROGRESS');
