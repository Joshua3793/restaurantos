-- Service gains its END time (minute-of-day). Nullable: additive, no backfill here.
ALTER TABLE "Service" ADD COLUMN IF NOT EXISTS "endMinutes" INTEGER;
