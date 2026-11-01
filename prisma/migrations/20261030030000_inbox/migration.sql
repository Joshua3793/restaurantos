-- CreateEnum
CREATE TYPE "InboxSeverity" AS ENUM ('NOW', 'TODAY', 'FYI');

-- CreateEnum
CREATE TYPE "InboxStatus" AS ENUM ('OPEN', 'SNOOZED', 'WAITING', 'DONE');

-- CreateEnum
CREATE TYPE "InboxSource" AS ENUM ('REPORT', 'FLAG', 'SYSTEM');

-- CreateEnum
CREATE TYPE "InboxEventKind" AS ENUM ('RAISED', 'SEEN', 'NOTE', 'SNOOZED', 'WAITING', 'REOPENED', 'DONE', 'CLEARED', 'RETAGGED');

-- CreateEnum
CREATE TYPE "InboxBuiltIn" AS ENUM ('FOOD_SAFETY', 'CHECKLISTS', 'PREP', 'STOCK', 'MONEY', 'TEAM');

-- CreateTable
CREATE TABLE "InboxTag" (
    "id" TEXT NOT NULL,
    "builtIn" "InboxBuiltIn",
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "cookCanPick" BOOLEAN NOT NULL DEFAULT false,
    "managerOnly" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboxTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboxFlagRoute" (
    "reason" "ChecklistFlagReason" NOT NULL,
    "tagId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboxFlagRoute_pkey" PRIMARY KEY ("reason")
);

-- CreateTable
CREATE TABLE "InboxItem" (
    "id" TEXT NOT NULL,
    "revenueCenterId" TEXT,
    "tagId" TEXT NOT NULL,
    "severity" "InboxSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "place" TEXT,
    "href" TEXT,
    "source" "InboxSource" NOT NULL,
    "sourceKey" TEXT,
    "managerOnly" BOOLEAN NOT NULL DEFAULT false,
    "status" "InboxStatus" NOT NULL DEFAULT 'OPEN',
    "snoozeUntil" TIMESTAMP(3),
    "raisedById" TEXT,
    "raisedByName" TEXT,
    "doneById" TEXT,
    "doneByName" TEXT,
    "doneAt" TIMESTAMP(3),
    "clearedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboxItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboxEvent" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "kind" "InboxEventKind" NOT NULL,
    "byId" TEXT,
    "byName" TEXT,
    "note" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboxSync" (
    "revenueCenterId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboxSync_pkey" PRIMARY KEY ("revenueCenterId")
);

-- CreateIndex
CREATE UNIQUE INDEX "InboxTag_builtIn_key" ON "InboxTag"("builtIn");

-- CreateIndex
CREATE UNIQUE INDEX "InboxItem_sourceKey_key" ON "InboxItem"("sourceKey");

-- CreateIndex
CREATE INDEX "InboxItem_status_revenueCenterId_idx" ON "InboxItem"("status", "revenueCenterId");

-- CreateIndex
CREATE INDEX "InboxItem_tagId_idx" ON "InboxItem"("tagId");

-- CreateIndex
CREATE INDEX "InboxItem_raisedById_idx" ON "InboxItem"("raisedById");

-- CreateIndex
CREATE INDEX "InboxEvent_itemId_at_idx" ON "InboxEvent"("itemId", "at");

-- CreateIndex
CREATE INDEX "InboxEvent_byId_kind_idx" ON "InboxEvent"("byId", "kind");

-- AddForeignKey
ALTER TABLE "InboxFlagRoute" ADD CONSTRAINT "InboxFlagRoute_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "InboxTag"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxItem" ADD CONSTRAINT "InboxItem_revenueCenterId_fkey" FOREIGN KEY ("revenueCenterId") REFERENCES "RevenueCenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxItem" ADD CONSTRAINT "InboxItem_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "InboxTag"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxEvent" ADD CONSTRAINT "InboxEvent_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InboxItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

