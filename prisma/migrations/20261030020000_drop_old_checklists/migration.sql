-- DropForeignKey
ALTER TABLE "EodCheckEntry" DROP CONSTRAINT "EodCheckEntry_closeId_fkey";

-- DropForeignKey
ALTER TABLE "EodCheckEntry" DROP CONSTRAINT "EodCheckEntry_itemId_fkey";

-- DropForeignKey
ALTER TABLE "EodCheckItem" DROP CONSTRAINT "EodCheckItem_revenueCenterId_fkey";

-- DropForeignKey
ALTER TABLE "OpenCheckItem" DROP CONSTRAINT "OpenCheckItem_revenueCenterId_fkey";

-- DropForeignKey
ALTER TABLE "OpenCheckTick" DROP CONSTRAINT "OpenCheckTick_itemId_fkey";

-- DropTable
DROP TABLE "EodCheckEntry";

-- DropTable
DROP TABLE "EodCheckItem";

-- DropTable
DROP TABLE "OpenCheckItem";

-- DropTable
DROP TABLE "OpenCheckTick";

