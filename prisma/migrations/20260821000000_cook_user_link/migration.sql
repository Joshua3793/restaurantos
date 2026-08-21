-- Link a roster row to an app login. Additive and nullable: no backfill.
ALTER TABLE "Cook" ADD COLUMN IF NOT EXISTS "userId" TEXT;

-- One login ↔ one roster row. Enforced here, not just in app code, so two
-- concurrent PATCHes cannot both succeed.
CREATE UNIQUE INDEX IF NOT EXISTS "Cook_userId_key" ON "Cook"("userId");

ALTER TABLE "Cook" DROP CONSTRAINT IF EXISTS "Cook_userId_fkey";
ALTER TABLE "Cook" ADD CONSTRAINT "Cook_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
