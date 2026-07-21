-- Phase 1b: additive columns, tables and indexes.
ALTER TABLE "UserScope" ADD COLUMN IF NOT EXISTS "clearance" "Role";

CREATE TABLE IF NOT EXISTS "AccessAuditEvent" (
  "id"           TEXT NOT NULL,
  "actorId"      TEXT,
  "actorEmail"   TEXT NOT NULL,
  "actorName"    TEXT,
  "targetUserId" TEXT,
  "targetEmail"  TEXT NOT NULL,
  "targetName"   TEXT,
  "action"       TEXT NOT NULL,
  "detail"       JSONB NOT NULL DEFAULT '{}',
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccessAuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AccessAuditEvent_createdAt_idx"    ON "AccessAuditEvent"("createdAt");
CREATE INDEX IF NOT EXISTS "AccessAuditEvent_targetUserId_idx" ON "AccessAuditEvent"("targetUserId");

ALTER TABLE "AccessAuditEvent"
  ADD CONSTRAINT "AccessAuditEvent_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AccessAuditEvent"
  ADD CONSTRAINT "AccessAuditEvent_targetUserId_fkey"
  FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- At most one OWNER. The index only covers rows where role = 'OWNER', and every
-- such row has the identical key 'OWNER', so a second one collides.
CREATE UNIQUE INDEX IF NOT EXISTS "User_single_owner" ON "User" ("role") WHERE "role" = 'OWNER';
