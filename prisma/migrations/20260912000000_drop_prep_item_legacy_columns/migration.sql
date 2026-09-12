-- Follow-up to 20260911000000_prep_item_stations: the single `station`, the
-- per-item ready-for service and the per-item timing overrides are gone from
-- the app (stations are a set; deadlines come from the urgency step; timing
-- from the recipe method). Applied AFTER the schema without these columns is
-- deployed — the previous Prisma client still selected them.
ALTER TABLE "PrepItem" DROP CONSTRAINT "PrepItem_targetServiceId_fkey";
ALTER TABLE "PrepItem"
  DROP COLUMN "station",
  DROP COLUMN "targetServiceId",
  DROP COLUMN "activeMinutesOverride",
  DROP COLUMN "passiveMinutesOverride",
  DROP COLUMN "passiveNoteOverride";
