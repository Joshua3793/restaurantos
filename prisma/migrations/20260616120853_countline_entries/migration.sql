-- Mixed-unit counting: optional [{unit,qty}] entries on a count line, summed to base.
ALTER TABLE "CountLine" ADD COLUMN IF NOT EXISTS "entries" JSONB;
