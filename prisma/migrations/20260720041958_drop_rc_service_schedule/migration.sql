-- Service type + hours now live solely in the Service model (name + timeMinutes + endMinutes).
-- RevenueCenter.serviceSchedule / schedulingMode are dead: nothing in src/ reads or writes them.
-- Task 2's backfill already carried this configuration into Service rows.
--
-- Pre-drop snapshot of the values being destroyed, recorded here so the legacy
-- configuration survives in version control (Location keeps its own copies):
--   BAR: mode=FIXED schedule={"0":[{"end":"15:00","label":"Cafe hours","start":"09:00"}],"1":[{"end":"15:00","label":"Cafe hours","start":"09:00"}],"2":[{"end":"15:00","label":"Cafe hours","start":"09:00"}],"3":[{"end":"15:00","label":"Cafe hours","start":"09:00"}],"4":[{"end":"15:00","label":"Cafe hours","start":"09:00"}],"5":[{"end":"16:00","label":"Cafe hours","start":"09:00"}],"6":[{"end":"16:00","label":"Cafe hours","start":"09:00"}]}
--   CATERING: mode=FIXED schedule=null
--   KITCHEN: mode=FIXED schedule={"0":[{"end":"15:00","label":"Brunch","start":"09:00"}],"1":[{"end":"15:00","label":"Brunch","start":"09:00"}],"2":[{"end":"15:00","label":"Brunch","start":"09:00"}],"3":[{"end":"15:00","label":"Brunch","start":"09:00"}],"4":[{"end":"15:00","label":"Brunch","start":"09:00"}],"5":[{"end":"16:00","label":"Brunch","start":"09:00"}],"6":[{"end":"16:00","label":"Brunch","start":"09:00"}]}
--
-- Service rows carrying this forward at drop time:
--   BAR | Brunch | 540-960 | active=true
--   BAR | Dinner | 1020-NULL | active=false
--   CATERING | Lunch | 690-NULL | active=false
--   CATERING | Dinner | 1020-NULL | active=false
--   KITCHEN | Brunch | 540-960 | active=true
--   KITCHEN | QA Test Service | 630-960 | active=false

ALTER TABLE "RevenueCenter" DROP COLUMN IF EXISTS "serviceSchedule";
ALTER TABLE "RevenueCenter" DROP COLUMN IF EXISTS "schedulingMode";
