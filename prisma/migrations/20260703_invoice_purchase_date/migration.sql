-- AlterTable
ALTER TABLE "InvoiceSession" ADD COLUMN     "purchaseDate" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "InvoiceSession_purchaseDate_idx" ON "InvoiceSession"("purchaseDate");
