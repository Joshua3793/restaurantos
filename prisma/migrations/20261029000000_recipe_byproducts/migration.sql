-- CreateTable
CREATE TABLE "RecipeByproduct" (
    "id" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "qty" DECIMAL(65,30) NOT NULL,
    "unit" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecipeByproduct_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecipeByproduct_recipeId_idx" ON "RecipeByproduct"("recipeId");

-- CreateIndex
CREATE INDEX "RecipeByproduct_inventoryItemId_idx" ON "RecipeByproduct"("inventoryItemId");

-- AddForeignKey
ALTER TABLE "RecipeByproduct" ADD CONSTRAINT "RecipeByproduct_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeByproduct" ADD CONSTRAINT "RecipeByproduct_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

