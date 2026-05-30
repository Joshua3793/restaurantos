-- AlterTable
ALTER TABLE "RevenueCenter" ADD COLUMN "schedulingMode" TEXT NOT NULL DEFAULT 'FIXED';
ALTER TABLE "RevenueCenter" ADD COLUMN "prepLeadMinutes" INTEGER;
ALTER TABLE "RevenueCenter" ADD COLUMN "serviceSchedule" JSONB;
