/**
 * Migration script: SQLite (dev.db) → Supabase PostgreSQL
 * Run with: npx ts-node --skip-project --transpile-only --compiler-options '{"module":"CommonJS","moduleResolution":"node"}' prisma/migrate-sqlite-to-postgres.ts
 */
import { execSync } from 'child_process'
import { PrismaClient } from '@prisma/client'
import path from 'path'

const prisma = new PrismaClient()
const DB = path.join(__dirname, 'dev.db')

function readTable(table: string): Record<string, unknown>[] {
  const out = execSync(`sqlite3 "${DB}" ".mode json" "SELECT * FROM ${table};"`, { encoding: 'utf8' })
  const trimmed = out.trim()
  if (!trimmed || trimmed === '[]') return []
  return JSON.parse(trimmed)
}

function toDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  if (!isNaN(n) && typeof v === 'number') return new Date(n)
  const d = new Date(String(v).replace(' ', 'T'))
  return isNaN(d.getTime()) ? new Date() : d
}
function toBool(v: unknown): boolean {
  return v === 1 || v === true || v === '1'
}
function toNum(v: unknown): number {
  return (v === null || v === undefined) ? 0 : Number(v)
}
function toNumOrNull(v: unknown): number | null {
  return (v === null || v === undefined) ? null : Number(v)
}

async function main() {
  console.log('Starting migration from SQLite → Supabase...\n')

  // ── 1. StorageArea ──────────────────────────────────────────────────────────
  const storageAreas = readTable('StorageArea')
  console.log(`StorageArea: ${storageAreas.length} rows`)
  for (const r of storageAreas) {
    await prisma.storageArea.upsert({
      where: { id: r.id as string },
      update: {},
      create: { id: r.id as string, name: r.name as string },
    })
  }

  // ── 2. Category ─────────────────────────────────────────────────────────────
  const categories = readTable('Category')
  console.log(`Category: ${categories.length} rows`)
  for (const r of categories) {
    await prisma.category.upsert({
      where: { name: r.name as string },
      update: {},
      create: { id: r.id as string, name: r.name as string },
    })
  }

  // ── 3. Supplier ─────────────────────────────────────────────────────────────
  const suppliers = readTable('Supplier')
  console.log(`Supplier: ${suppliers.length} rows`)
  for (const r of suppliers) {
    await prisma.supplier.upsert({
      where: { id: r.id as string },
      update: {},
      create: {
        id:          r.id as string,
        name:        r.name as string,
        contactName: (r.contactName ?? r.contact) as string | null ?? null,
        email:       r.email as string | null ?? null,
        phone:       r.phone as string | null ?? null,
      },
    })
  }

  // ── 4. InventoryItem ────────────────────────────────────────────────────────
  const items = readTable('InventoryItem')
  console.log(`InventoryItem: ${items.length} rows`)
  for (const r of items) {
    await prisma.inventoryItem.upsert({
      where: { id: r.id as string },
      update: {},
      create: {
        id:                 r.id as string,
        itemName:           r.itemName as string,
        category:           r.category as string,
        supplierId:         r.supplierId as string | null ?? null,
        storageAreaId:      r.storageAreaId as string | null ?? null,
        purchaseUnit:       r.purchaseUnit as string,
        qtyPerPurchaseUnit: toNum(r.qtyPerPurchaseUnit),
        purchasePrice:      toNum(r.purchasePrice),
        baseUnit:           r.baseUnit as string,
        packSize:           toNum(r.packSize),
        packUOM:            r.packUOM as string,
        countUOM:           (r.countUOM as string) || 'each',
        conversionFactor:   toNum(r.conversionFactor),
        pricePerBaseUnit:   toNum(r.pricePerBaseUnit),
        stockOnHand:        toNum(r.stockOnHand),
        lastUpdated:        toDate(r.lastUpdated) ?? new Date(),
        abbreviation:       r.abbreviation as string | null ?? null,
        location:           r.location as string | null ?? null,
        isActive:           toBool(r.isActive),
        lastCountDate:      toDate(r.lastCountDate),
        lastCountQty:       toNumOrNull(r.lastCountQty),
      },
    })
  }

  // ── 5. RecipeCategory ───────────────────────────────────────────────────────
  const recipeCategories = readTable('RecipeCategory')
  console.log(`RecipeCategory: ${recipeCategories.length} rows`)
  for (const r of recipeCategories) {
    await prisma.recipeCategory.upsert({
      where: { id: r.id as string },
      update: {},
      create: {
        id:        r.id as string,
        name:      r.name as string,
        type:      (r.type as string) || 'PREP',
        color:     r.color as string | null ?? null,
        sortOrder: r.sortOrder ? Number(r.sortOrder) : 0,
      },
    })
  }

  // ── 6. Recipe ───────────────────────────────────────────────────────────────
  const recipes = readTable('Recipe')
  // Build set of valid inventoryItem IDs so we can null out dangling refs
  const validItemIds = new Set(items.map(i => i.id as string))
  console.log(`Recipe: ${recipes.length} rows`)
  for (const r of recipes) {
    const invItemId = (r.inventoryItemId && validItemIds.has(r.inventoryItemId as string))
      ? r.inventoryItemId as string : null
    await prisma.recipe.upsert({
      where: { id: r.id as string },
      update: {},
      create: {
        id:              r.id as string,
        name:            r.name as string,
        type:            (r.type as string) || 'MENU',
        categoryId:      r.categoryId as string,
        inventoryItemId: invItemId,
        baseYieldQty:    toNum(r.baseYieldQty),
        yieldUnit:       (r.yieldUnit as string) || 'each',
        portionSize:     toNumOrNull(r.portionSize),
        portionUnit:     r.portionUnit as string | null ?? null,
        menuPrice:       toNumOrNull(r.menuPrice),
        isActive:        toBool(r.isActive),
        notes:           r.notes as string | null ?? null,
        createdAt:       toDate(r.createdAt) ?? new Date(),
        updatedAt:       toDate(r.updatedAt) ?? new Date(),
      },
    })
  }

  // ── 7. RecipeIngredient ─────────────────────────────────────────────────────
  const ingredients = readTable('RecipeIngredient')
  console.log(`RecipeIngredient: ${ingredients.length} rows`)
  for (const r of ingredients) {
    await prisma.recipeIngredient.upsert({
      where: { id: r.id as string },
      update: {},
      create: {
        id:              r.id as string,
        recipeId:        r.recipeId as string,
        inventoryItemId: r.inventoryItemId as string | null ?? null,
        linkedRecipeId:  r.linkedRecipeId as string | null ?? null,
        qtyBase:         toNum(r.qtyBase),
        unit:            r.unit as string,
        sortOrder:       r.sortOrder ? Number(r.sortOrder) : 0,
        notes:           r.notes as string | null ?? null,
        recipePercent:   toNumOrNull(r.recipePercent),
      },
    })
  }

  // ── 8. CountSession ─────────────────────────────────────────────────────────
  const countSessions = readTable('CountSession')
  console.log(`CountSession: ${countSessions.length} rows`)
  for (const r of countSessions) {
    await prisma.countSession.upsert({
      where: { id: r.id as string },
      update: {},
      create: {
        id:                r.id as string,
        sessionDate:       toDate(r.sessionDate) ?? new Date(),
        label:             (r.label as string) || 'Full count',
        type:              (r.type as string) || 'FULL',
        areaFilter:        r.areaFilter as string | null ?? null,
        countedBy:         (r.countedBy as string) || 'Manager',
        status:            (r.status as string) || 'FINALIZED',
        startedAt:         toDate(r.startedAt) ?? new Date(),
        finalizedAt:       toDate(r.finalizedAt),
        totalCountedValue: toNum(r.totalCountedValue),
        notes:             r.notes as string | null ?? null,
      },
    })
  }

  // ── 9. CountLine ────────────────────────────────────────────────────────────
  const countLines = readTable('CountLine')
  console.log(`CountLine: ${countLines.length} rows`)
  for (const r of countLines) {
    await prisma.countLine.upsert({
      where: { id: r.id as string },
      update: {},
      create: {
        id:              r.id as string,
        sessionId:       r.sessionId as string,
        inventoryItemId: r.inventoryItemId as string,
        expectedQty:     toNum(r.expectedQty),
        countedQty:      toNumOrNull(r.countedQty),
        selectedUom:     r.selectedUom as string,
        skipped:         toBool(r.skipped),
        variancePct:     toNumOrNull(r.variancePct),
        varianceCost:    toNumOrNull(r.varianceCost),
        priceAtCount:    toNum(r.priceAtCount),
        notes:           r.notes as string | null ?? null,
        sortOrder:       r.sortOrder ? Number(r.sortOrder) : 0,
      },
    })
  }

  // ── 10. SalesEntry ──────────────────────────────────────────────────────────
  const salesEntries = readTable('SalesEntry')
  console.log(`SalesEntry: ${salesEntries.length} rows`)
  for (const r of salesEntries) {
    await prisma.salesEntry.upsert({
      where: { id: r.id as string },
      update: {},
      create: {
        id:           r.id as string,
        date:         toDate(r.date) ?? new Date(),
        totalRevenue: toNum(r.totalRevenue),
        foodSalesPct: toNum(r.foodSalesPct ?? 0.7),
        covers:       r.covers !== null && r.covers !== undefined ? Math.round(toNum(r.covers)) : null,
        notes:        r.notes as string | null ?? null,
        createdAt:    toDate(r.createdAt) ?? new Date(),
      },
    })
  }

  // ── 11. SaleLineItem ────────────────────────────────────────────────────────
  const saleLineItems = readTable('SaleLineItem')
  console.log(`SaleLineItem: ${saleLineItems.length} rows`)
  for (const r of saleLineItems) {
    await prisma.saleLineItem.upsert({
      where: { id: r.id as string },
      update: {},
      create: {
        id:       r.id as string,
        saleId:   (r.saleId ?? r.salesEntryId) as string,
        recipeId: r.recipeId as string,
        qtySold:  Math.round(toNum(r.qtySold ?? r.qty ?? 0)),
      },
    })
  }

  // ── 12. WastageLog ──────────────────────────────────────────────────────────
  const wastageLogs = readTable('WastageLog')
  console.log(`WastageLog: ${wastageLogs.length} rows`)
  for (const r of wastageLogs) {
    await prisma.wastageLog.upsert({
      where: { id: r.id as string },
      update: {},
      create: {
        id:              r.id as string,
        inventoryItemId: r.inventoryItemId as string,
        date:            toDate(r.date) ?? new Date(),
        qtyWasted:       toNum(r.qtyWasted ?? r.qty),
        unit:            r.unit as string,
        reason:          (r.reason as string) || 'UNKNOWN',
        costImpact:      toNum(r.costImpact ?? r.cost),
        loggedBy:        (r.loggedBy as string) || 'System',
        notes:           r.notes as string | null ?? null,
      },
    })
  }

  // ── 13. InventorySupplierPrice ──────────────────────────────────────────────
  const supplierPrices = readTable('InventorySupplierPrice')
  console.log(`InventorySupplierPrice: ${supplierPrices.length} rows`)
  for (const r of supplierPrices) {
    await prisma.inventorySupplierPrice.upsert({
      where: { id: r.id as string },
      update: {},
      create: {
        id:               r.id as string,
        inventoryItemId:  r.inventoryItemId as string,
        supplierName:     r.supplierName as string,
        supplierId:       r.supplierId as string | null ?? null,
        lastPrice:        toNum(r.lastPrice),
        pricePerBaseUnit: toNum(r.pricePerBaseUnit),
        isPrimary:        toBool(r.isPrimary),
        lastUpdated:      toDate(r.lastUpdated) ?? new Date(),
      },
    })
  }

  console.log('\n✅ Migration complete! All data copied to Supabase.')
  console.log('Restart your dev server to see the data.')
}

main()
  .catch(e => { console.error('\n❌ Migration failed:', e.message); process.exit(1) })
  .finally(() => prisma.$disconnect())
