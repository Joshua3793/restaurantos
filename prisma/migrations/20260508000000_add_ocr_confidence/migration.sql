-- AlterTable: add per-line OCR confidence so the review UI can highlight
-- values Claude itself flagged as uncertain.
ALTER TABLE "InvoiceScanItem" ADD COLUMN "ocrConfidence" TEXT;
ALTER TABLE "InvoiceScanItem" ADD COLUMN "ocrNotes" TEXT;
