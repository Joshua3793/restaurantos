-- CreateTable
CREATE TABLE "InvoiceBatch" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ANALYZING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceBatchFile" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "detectedInvoiceNumber" TEXT,
    "detectedSupplierName" TEXT,
    "metaStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceBatchFile_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "InvoiceSession" ADD COLUMN "batchId" TEXT;

-- AlterTable
ALTER TABLE "InvoiceScanItem" ADD COLUMN "editedDescription" TEXT;

-- AddForeignKey
ALTER TABLE "InvoiceBatchFile" ADD CONSTRAINT "InvoiceBatchFile_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "InvoiceBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceSession" ADD CONSTRAINT "InvoiceSession_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "InvoiceBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
