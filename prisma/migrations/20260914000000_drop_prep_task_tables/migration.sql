-- DropForeignKey
ALTER TABLE "PrepTask" DROP CONSTRAINT "PrepTask_linkedInventoryItemId_fkey";

-- DropForeignKey
ALTER TABLE "PrepTask" DROP CONSTRAINT "PrepTask_revenueCenterId_fkey";

-- DropForeignKey
ALTER TABLE "PrepTaskLog" DROP CONSTRAINT "PrepTaskLog_prepTaskId_fkey";

-- DropTable
DROP TABLE "PrepTask";

-- DropTable
DROP TABLE "PrepTaskLog";

