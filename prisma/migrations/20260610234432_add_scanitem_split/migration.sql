-- AlterTable
ALTER TABLE "InvoiceScanItem" ADD COLUMN     "splitToSessionId" TEXT;

-- CreateIndex
CREATE INDEX "InvoiceScanItem_splitToSessionId_idx" ON "InvoiceScanItem"("splitToSessionId");

