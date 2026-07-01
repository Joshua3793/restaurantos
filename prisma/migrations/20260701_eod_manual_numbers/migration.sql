-- AlterTable
ALTER TABLE "EodClose" ADD COLUMN     "compsVoids" DECIMAL(65,30),
ADD COLUMN     "discounts" DECIMAL(65,30),
ADD COLUMN     "grossSales" DECIMAL(65,30),
ADD COLUMN     "labourCost" DECIMAL(65,30);
