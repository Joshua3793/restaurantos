-- AlterTable
ALTER TABLE "ChecklistItem" ADD COLUMN     "dueBy" TEXT,
ADD COLUMN     "linkId" TEXT;

-- AlterTable
ALTER TABLE "ChecklistRunLine" ADD COLUMN     "dueBy" TEXT,
ADD COLUMN     "linkId" TEXT;

-- CreateIndex
CREATE INDEX "ChecklistItem_linkId_idx" ON "ChecklistItem"("linkId");

-- CreateIndex
CREATE INDEX "ChecklistRunLine_linkId_idx" ON "ChecklistRunLine"("linkId");

