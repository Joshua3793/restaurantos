-- Partial unique index: at most one default Location.
-- Applied to the live DB via scripts/apply-location-default-index.ts (pooler).
CREATE UNIQUE INDEX IF NOT EXISTS "Location_one_default" ON "Location" ("isDefault") WHERE "isDefault";
