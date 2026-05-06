-- AlterTable
ALTER TABLE "SalesEntry" ADD COLUMN "periodType" TEXT NOT NULL DEFAULT 'day';
ALTER TABLE "SalesEntry" ADD COLUMN "endDate" TIMESTAMP(3);
