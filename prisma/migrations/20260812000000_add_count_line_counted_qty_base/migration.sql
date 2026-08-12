-- Freeze the counted base quantity at entry time. Nullable: legacy lines predate it.
ALTER TABLE "CountLine" ADD COLUMN "countedQtyBase" DECIMAL(65,30);
