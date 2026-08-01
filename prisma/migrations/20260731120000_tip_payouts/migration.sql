-- Tip payouts: additive only. No existing column is altered or dropped.

CREATE TABLE "TipSettings" (
  "id" TEXT NOT NULL DEFAULT 'singleton',
  "poolBasis" TEXT NOT NULL DEFAULT 'NET_SALES',
  "includeAutoGratuity" BOOLEAN NOT NULL DEFAULT true,
  "poolRatePct" DECIMAL(65,30) NOT NULL DEFAULT 5,
  "defaultDailyHourCap" DECIMAL(65,30),
  "rewardTiers" JSONB NOT NULL DEFAULT '[1.25, 1.5, 2]',
  "roundingStepCents" INTEGER NOT NULL DEFAULT 100,
  "periodDays" INTEGER NOT NULL DEFAULT 14,
  "periodStartDow" INTEGER NOT NULL DEFAULT 0,
  "salesSourceMode" TEXT NOT NULL DEFAULT 'LOCATION',
  "salesLocationId" TEXT,
  "salesRcIds" JSONB NOT NULL DEFAULT '[]',
  "poolRevenueCenterId" TEXT,
  "denoms" JSONB NOT NULL DEFAULT '[{"v":10000,"l":"$100","on":false},{"v":5000,"l":"$50","on":true},{"v":2000,"l":"$20","on":true},{"v":1000,"l":"$10","on":true},{"v":500,"l":"$5","on":true},{"v":200,"l":"$2","on":true},{"v":100,"l":"$1","on":true},{"v":25,"l":"25¢","on":true},{"v":10,"l":"10¢","on":true},{"v":5,"l":"5¢","on":true}]',
  "posMap" JSONB NOT NULL DEFAULT '{}',
  "poolDepartments" JSONB NOT NULL DEFAULT '["Back of House"]',
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TipSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TipRole" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "multiplier" DECIMAL(65,30) NOT NULL DEFAULT 1,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "TipRole_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TipPeriod" (
  "id" TEXT NOT NULL,
  "revenueCenterId" TEXT NOT NULL,
  "startDate" TEXT NOT NULL,
  "endDate" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "poolBasis" TEXT NOT NULL DEFAULT 'NET_SALES',
  "poolRatePct" DECIMAL(65,30) NOT NULL,
  "roundingStepCents" INTEGER NOT NULL DEFAULT 100,
  "salesOverride" JSONB,
  "tipsOverride" JSONB,
  "salesFileName" TEXT,
  "clockFileName" TEXT,
  "salesImportedAt" TIMESTAMP(3),
  "clockImportedAt" TIMESTAMP(3),
  "ignoredClockIds" JSONB NOT NULL DEFAULT '[]',
  "paidAt" TIMESTAMP(3),
  "paidByName" TEXT,
  "snapshot" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TipPeriod_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TipPunch" (
  "id" TEXT NOT NULL,
  "periodId" TEXT NOT NULL,
  "clockId" TEXT NOT NULL,
  "firstName" TEXT NOT NULL,
  "lastName" TEXT NOT NULL,
  "position" TEXT NOT NULL,
  "department" TEXT NOT NULL,
  "dayIndex" INTEGER NOT NULL,
  "hours" DECIMAL(65,30) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Approved',
  "note" TEXT,
  CONSTRAINT "TipPunch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TipDayAdjustment" (
  "id" TEXT NOT NULL,
  "periodId" TEXT NOT NULL,
  "cookId" TEXT NOT NULL,
  "dayIndex" INTEGER NOT NULL,
  "hours" DECIMAL(65,30),
  "boost" DECIMAL(65,30) NOT NULL DEFAULT 1,
  CONSTRAINT "TipDayAdjustment_pkey" PRIMARY KEY ("id")
);

-- Customer tips per day. Nullable: NULL = no tip data, 0 = genuinely no tips.
-- Split so TipSettings.includeAutoGratuity can be flipped without a re-sync.
ALTER TABLE "SalesEntry"
  ADD COLUMN "tipsCollected" DECIMAL(65,30),
  ADD COLUMN "autoGratuity" DECIMAL(65,30);

ALTER TABLE "Cook"
  ADD COLUMN "lastName" TEXT,
  ADD COLUMN "clockId" TEXT,
  ADD COLUMN "wage" DECIMAL(65,30),
  ADD COLUMN "dailyHourCap" DECIMAL(65,30),
  ADD COLUMN "tipRoleId" TEXT,
  ADD COLUMN "onTipPool" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "posPosition" TEXT;

CREATE UNIQUE INDEX "Cook_clockId_key" ON "Cook"("clockId");
CREATE UNIQUE INDEX "TipPeriod_revenueCenterId_startDate_key" ON "TipPeriod"("revenueCenterId", "startDate");
CREATE INDEX "TipPeriod_revenueCenterId_status_idx" ON "TipPeriod"("revenueCenterId", "status");
CREATE INDEX "TipPunch_periodId_idx" ON "TipPunch"("periodId");
CREATE INDEX "TipPunch_periodId_clockId_idx" ON "TipPunch"("periodId", "clockId");
CREATE UNIQUE INDEX "TipDayAdjustment_periodId_cookId_dayIndex_key" ON "TipDayAdjustment"("periodId", "cookId", "dayIndex");
CREATE INDEX "TipDayAdjustment_periodId_idx" ON "TipDayAdjustment"("periodId");

ALTER TABLE "Cook" ADD CONSTRAINT "Cook_tipRoleId_fkey"
  FOREIGN KEY ("tipRoleId") REFERENCES "TipRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TipPeriod" ADD CONSTRAINT "TipPeriod_revenueCenterId_fkey"
  FOREIGN KEY ("revenueCenterId") REFERENCES "RevenueCenter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TipPunch" ADD CONSTRAINT "TipPunch_periodId_fkey"
  FOREIGN KEY ("periodId") REFERENCES "TipPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TipDayAdjustment" ADD CONSTRAINT "TipDayAdjustment_periodId_fkey"
  FOREIGN KEY ("periodId") REFERENCES "TipPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TipDayAdjustment" ADD CONSTRAINT "TipDayAdjustment_cookId_fkey"
  FOREIGN KEY ("cookId") REFERENCES "Cook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "TipRole" ("id", "name", "multiplier", "sortOrder") VALUES
  ('tiprole_lead',   'Lead',   1.5, 0),
  ('tiprole_line',   'Line',   1.2, 1),
  ('tiprole_junior', 'Junior', 1.1, 2),
  ('tiprole_dish',   'Dish',   1.0, 3)
ON CONFLICT DO NOTHING;
