-- PrepItem.stations replaces the single PrepItem.station. Empty = any station.
-- `station` is left in place until the follow-up drop migration (deploy first, drop second).
ALTER TABLE "PrepItem" ADD COLUMN "stations" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "PrepItem"
SET "stations" = ARRAY["station"]
WHERE "station" IS NOT NULL AND btrim("station") <> '';
