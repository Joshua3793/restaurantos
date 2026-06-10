-- AlterTable
ALTER TABLE "InvoiceMatchRule" ADD COLUMN     "supplierItemCode" TEXT;

-- AlterTable
ALTER TABLE "InvoiceScanItem" ADD COLUMN     "applyInvoiceFormat" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN     "ocrFormatNotes" TEXT;

-- CreateIndex
CREATE INDEX "InvoiceMatchRule_supplierName_supplierItemCode_idx" ON "InvoiceMatchRule"("supplierName", "supplierItemCode");

