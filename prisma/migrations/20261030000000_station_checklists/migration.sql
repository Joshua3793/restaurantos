-- CreateEnum
CREATE TYPE "ChecklistPhase" AS ENUM ('OPEN', 'CLOSE');

-- CreateEnum
CREATE TYPE "ChecklistAnswer" AS ENUM ('TICK', 'NUMBER', 'TEMP');

-- CreateEnum
CREATE TYPE "ChecklistLineStatus" AS ENUM ('TODO', 'DONE', 'FLAGGED');

-- CreateEnum
CREATE TYPE "ChecklistFlagReason" AS ENUM ('BROKEN', 'RAN_OUT', 'OUT_OF_RANGE', 'OTHER');

-- CreateEnum
CREATE TYPE "ChecklistRunStatus" AS ENUM ('OPEN', 'SIGNED');

-- CreateTable
CREATE TABLE "ChecklistStation" (
    "id" TEXT NOT NULL,
    "revenueCenterId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#71717a',
    "isShared" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChecklistStation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChecklistCategory" (
    "id" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "phase" "ChecklistPhase" NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChecklistCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChecklistItem" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "howTo" TEXT,
    "isBlocker" BOOLEAN NOT NULL DEFAULT false,
    "answer" "ChecklistAnswer" NOT NULL DEFAULT 'TICK',
    "unit" TEXT,
    "safeMin" DECIMAL(65,30),
    "safeMax" DECIMAL(65,30),
    "tempUnitId" TEXT,
    "days" INTEGER NOT NULL DEFAULT 127,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChecklistRun" (
    "id" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "phase" "ChecklistPhase" NOT NULL,
    "businessDate" TEXT NOT NULL,
    "status" "ChecklistRunStatus" NOT NULL DEFAULT 'OPEN',
    "signedOffById" TEXT,
    "signedOffByName" TEXT,
    "signedOffAt" TIMESTAMP(3),
    "handoverNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChecklistRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChecklistRunLine" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "itemId" TEXT,
    "categoryName" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "howTo" TEXT,
    "isBlocker" BOOLEAN NOT NULL,
    "answer" "ChecklistAnswer" NOT NULL,
    "unit" TEXT,
    "safeMin" DECIMAL(65,30),
    "safeMax" DECIMAL(65,30),
    "tempUnitId" TEXT,
    "sortOrder" INTEGER NOT NULL,
    "status" "ChecklistLineStatus" NOT NULL DEFAULT 'TODO',
    "value" DECIMAL(65,30),
    "doneById" TEXT,
    "doneByName" TEXT,
    "doneAt" TIMESTAMP(3),
    "flagReason" "ChecklistFlagReason",
    "flagNote" TEXT,
    "resolvedById" TEXT,
    "resolvedByName" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChecklistRunLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChecklistRunCrew" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userName" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChecklistRunCrew_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChecklistStation_revenueCenterId_isActive_idx" ON "ChecklistStation"("revenueCenterId", "isActive");

-- CreateIndex
CREATE INDEX "ChecklistCategory_stationId_phase_idx" ON "ChecklistCategory"("stationId", "phase");

-- CreateIndex
CREATE INDEX "ChecklistItem_categoryId_isActive_idx" ON "ChecklistItem"("categoryId", "isActive");

-- CreateIndex
CREATE INDEX "ChecklistRun_businessDate_idx" ON "ChecklistRun"("businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "ChecklistRun_stationId_phase_businessDate_key" ON "ChecklistRun"("stationId", "phase", "businessDate");

-- CreateIndex
CREATE INDEX "ChecklistRunLine_runId_idx" ON "ChecklistRunLine"("runId");

-- CreateIndex
CREATE INDEX "ChecklistRunLine_status_resolvedAt_idx" ON "ChecklistRunLine"("status", "resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChecklistRunLine_runId_itemId_key" ON "ChecklistRunLine"("runId", "itemId");

-- CreateIndex
CREATE INDEX "ChecklistRunCrew_userId_idx" ON "ChecklistRunCrew"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ChecklistRunCrew_runId_userId_key" ON "ChecklistRunCrew"("runId", "userId");

-- AddForeignKey
ALTER TABLE "ChecklistStation" ADD CONSTRAINT "ChecklistStation_revenueCenterId_fkey" FOREIGN KEY ("revenueCenterId") REFERENCES "RevenueCenter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChecklistCategory" ADD CONSTRAINT "ChecklistCategory_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "ChecklistStation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChecklistItem" ADD CONSTRAINT "ChecklistItem_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ChecklistCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChecklistItem" ADD CONSTRAINT "ChecklistItem_tempUnitId_fkey" FOREIGN KEY ("tempUnitId") REFERENCES "TempUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChecklistRun" ADD CONSTRAINT "ChecklistRun_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "ChecklistStation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChecklistRunLine" ADD CONSTRAINT "ChecklistRunLine_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ChecklistRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChecklistRunLine" ADD CONSTRAINT "ChecklistRunLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "ChecklistItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChecklistRunCrew" ADD CONSTRAINT "ChecklistRunCrew_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ChecklistRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

