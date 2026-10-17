-- AlterTable
ALTER TABLE "Recipe" ADD COLUMN     "sourceScanId" TEXT;

-- AlterTable
ALTER TABLE "RecipeIngredient" ADD COLUMN     "allergens" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "RecipeScan" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UPLOADING',
    "error" TEXT,
    "createdById" TEXT NOT NULL,
    "revenueCenterId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecipeScan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeScanFile" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RecipeScanFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeScanDraft" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "savedRecipeId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecipeScanDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeTextAlias" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "inventoryItemId" TEXT,
    "linkedRecipeId" TEXT,
    "useCount" INTEGER NOT NULL DEFAULT 1,
    "lastUsed" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecipeTextAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemCountMeasure" (
    "id" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "word" TEXT NOT NULL,
    "qty" DECIMAL(65,30) NOT NULL,
    "unit" TEXT NOT NULL,

    CONSTRAINT "ItemCountMeasure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RecipeScanDraft_savedRecipeId_key" ON "RecipeScanDraft"("savedRecipeId");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeTextAlias_text_key" ON "RecipeTextAlias"("text");

-- CreateIndex
CREATE UNIQUE INDEX "ItemCountMeasure_inventoryItemId_word_key" ON "ItemCountMeasure"("inventoryItemId", "word");

-- AddForeignKey
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_sourceScanId_fkey" FOREIGN KEY ("sourceScanId") REFERENCES "RecipeScan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeScanFile" ADD CONSTRAINT "RecipeScanFile_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "RecipeScan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeScanDraft" ADD CONSTRAINT "RecipeScanDraft_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "RecipeScan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

