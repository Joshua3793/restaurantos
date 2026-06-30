-- The Prisma @@unique([userId, locationId, revenueCenterId]) does NOT prevent
-- duplicate rows when a column is NULL (Postgres treats NULLs as distinct).
-- Every UserScope row has exactly ONE of locationId/revenueCenterId set, so
-- that unique index never blocks duplicates. NULLS NOT DISTINCT (Postgres 15+)
-- closes the gap. Prisma cannot express this, so it is applied out-of-band via
-- scripts/apply-userscope-index.ts; this file is for migration history only.
CREATE UNIQUE INDEX IF NOT EXISTS "UserScope_user_node_unique" ON "UserScope" ("userId", "locationId", "revenueCenterId") NULLS NOT DISTINCT;
