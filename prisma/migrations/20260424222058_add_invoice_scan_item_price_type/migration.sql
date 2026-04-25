-- AlterTable
ALTER TABLE "InvoiceScanItem" ADD COLUMN "rawPriceType" TEXT NOT NULL DEFAULT 'CASE';
