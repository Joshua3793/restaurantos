-- CreateTable
CREATE TABLE "PrepCrewDay" (
    "id" TEXT NOT NULL,
    "revenueCenterId" TEXT NOT NULL,
    "listDate" TIMESTAMP(3) NOT NULL,
    "cookIds" JSONB NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrepCrewDay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PrepCrewDay_revenueCenterId_listDate_key" ON "PrepCrewDay"("revenueCenterId", "listDate");

-- AddForeignKey
ALTER TABLE "PrepCrewDay" ADD CONSTRAINT "PrepCrewDay_revenueCenterId_fkey" FOREIGN KEY ("revenueCenterId") REFERENCES "RevenueCenter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

