-- CreateTable
CREATE TABLE "InvoiceApproveUndo" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "prev" JSONB,
    "next" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceApproveUndo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceApproveUndo_sessionId_kind_targetId_key" ON "InvoiceApproveUndo"("sessionId", "kind", "targetId");

-- CreateIndex
CREATE INDEX "InvoiceApproveUndo_kind_targetId_idx" ON "InvoiceApproveUndo"("kind", "targetId");

-- AddForeignKey
ALTER TABLE "InvoiceApproveUndo" ADD CONSTRAINT "InvoiceApproveUndo_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InvoiceSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
