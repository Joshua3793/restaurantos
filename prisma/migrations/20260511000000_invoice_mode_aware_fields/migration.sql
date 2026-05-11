-- Mode-aware invoice OCR persistence.
-- The OCR layer now returns per-line pricing mode, catchweight flag, rate/rateUOM,
-- qtyOrdered (separate from qtyShipped), lineCategory, supplierItemCode, and per-row
-- tax fields. The session header now carries individual fee fields (fuel, freight,
-- min order, discount) and split GST/HST/PST instead of a single tax aggregate.
-- The legacy InvoiceSession.tax column stays for back-compat (process route writes
-- gst+hst+pst into it).

-- ── InvoiceSession header fees ────────────────────────────────────────────────
ALTER TABLE "InvoiceSession" ADD COLUMN "poNumber"        TEXT;
ALTER TABLE "InvoiceSession" ADD COLUMN "discount"        DECIMAL(65,30);
ALTER TABLE "InvoiceSession" ADD COLUMN "fuelSurcharge"   DECIMAL(65,30);
ALTER TABLE "InvoiceSession" ADD COLUMN "freight"         DECIMAL(65,30);
ALTER TABLE "InvoiceSession" ADD COLUMN "minimumOrderFee" DECIMAL(65,30);
ALTER TABLE "InvoiceSession" ADD COLUMN "gst"             DECIMAL(65,30);
ALTER TABLE "InvoiceSession" ADD COLUMN "hst"             DECIMAL(65,30);
ALTER TABLE "InvoiceSession" ADD COLUMN "pst"             DECIMAL(65,30);
ALTER TABLE "InvoiceSession" ADD COLUMN "otherCharges"    JSONB;

-- ── InvoiceScanItem mode-aware fields ─────────────────────────────────────────
ALTER TABLE "InvoiceScanItem" ADD COLUMN "pricingMode"       TEXT;
ALTER TABLE "InvoiceScanItem" ADD COLUMN "pricingModeSignal" TEXT;
ALTER TABLE "InvoiceScanItem" ADD COLUMN "qtyOrdered"        DECIMAL(65,30);
ALTER TABLE "InvoiceScanItem" ADD COLUMN "qtyOrderedUOM"     TEXT;
ALTER TABLE "InvoiceScanItem" ADD COLUMN "rate"              DECIMAL(65,30);
ALTER TABLE "InvoiceScanItem" ADD COLUMN "rateUOM"           TEXT;
ALTER TABLE "InvoiceScanItem" ADD COLUMN "isCatchweight"     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "InvoiceScanItem" ADD COLUMN "nominalWeight"     DECIMAL(65,30);
ALTER TABLE "InvoiceScanItem" ADD COLUMN "lineCategory"      TEXT;
ALTER TABLE "InvoiceScanItem" ADD COLUMN "supplierItemCode"  TEXT;
ALTER TABLE "InvoiceScanItem" ADD COLUMN "taxFlag"           TEXT;
ALTER TABLE "InvoiceScanItem" ADD COLUMN "lineTaxAmount"     DECIMAL(65,30);
