/**
 * Migrates data from the local SQLite dev.db to the PostgreSQL (Supabase) database.
 * Run with:  npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/migrate-sqlite-to-pg.ts
 */

import { execSync } from 'child_process'
import path from 'path'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const DB = path.resolve(__dirname, '../prisma/dev.db')

function query<T>(sql: string): T[] {
  try {
    const out = execSync(`sqlite3 "${DB}" --json "${sql.replace(/"/g, '\\"')}"`, {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    }).trim()
    return out ? (JSON.parse(out) as T[]) : []
  } catch {
    return []
  }
}

// SQLite stores timestamps as Unix ms integers AND as ISO strings in different tables.
// This normalises both forms to a JS Date.
function toDate(v: unknown): Date | null {
  if (v == null) return null
  if (typeof v === 'number') return new Date(v)
  if (typeof v === 'string') {
    if (/^\d{10,13}$/.test(v)) return new Date(Number(v))
    const d = new Date(v)
    return isNaN(d.getTime()) ? null : d
  }
  return null
}

function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  return v === 1 || v === '1' || v === 'true'
}

async function main() {
  console.log('Starting SQLite → PostgreSQL migration…\n')

  // ── 1. StorageArea ────────────────────────────────────────────────────────
  const storageAreas = query<{ id: string; name: string }>('SELECT * FROM StorageArea')
  console.log(`StorageArea: ${storageAreas.length} rows`)
  for (const r of storageAreas) {
    await prisma.storageArea.upsert({
      where: { id: r.id },
      create: { id: r.id, name: r.name },
      update: { name: r.name },
    })
  }

  // ── 2. Category ───────────────────────────────────────────────────────────
  const categories = query<{ id: string; name: string }>('SELECT * FROM Category')
  console.log(`Category: ${categories.length} rows`)
  for (const r of categories) {
    await prisma.category.upsert({
      where: { id: r.id },
      create: { id: r.id, name: r.name },
      update: { name: r.name },
    })
  }

  // ── 3. Supplier ───────────────────────────────────────────────────────────
  const suppliers = query<{
    id: string; name: string; contactName: string | null; phone: string | null
    email: string | null; orderPlatform: string | null; cutoffDays: string | null
    deliveryDays: string | null; createdAt: unknown
  }>('SELECT * FROM Supplier')
  console.log(`Supplier: ${suppliers.length} rows`)
  for (const r of suppliers) {
    await prisma.supplier.upsert({
      where: { id: r.id },
      create: {
        id: r.id, name: r.name, contactName: r.contactName, phone: r.phone,
        email: r.email, orderPlatform: r.orderPlatform, cutoffDays: r.cutoffDays,
        deliveryDays: r.deliveryDays, createdAt: toDate(r.createdAt) ?? new Date(),
      },
      update: { name: r.name },
    })
  }

  // ── 4. RecipeCategory ─────────────────────────────────────────────────────
  const recipeCategories = query<{
    id: string; name: string; type: string; color: string | null; sortOrder: number
  }>('SELECT * FROM RecipeCategory')
  console.log(`RecipeCategory: ${recipeCategories.length} rows`)
  for (const r of recipeCategories) {
    await prisma.recipeCategory.upsert({
      where: { id: r.id },
      create: { id: r.id, name: r.name, type: r.type, color: r.color, sortOrder: r.sortOrder ?? 0 },
      update: { name: r.name, type: r.type, color: r.color },
    })
  }

  // ── 5. InventoryItem ──────────────────────────────────────────────────────
  const items = query<{
    id: string; itemName: string; category: string; supplierId: string | null
    storageAreaId: string | null; purchaseUnit: string; qtyPerPurchaseUnit: number
    purchasePrice: number; baseUnit: string; packSize: number; packUOM: string
    countUOM: string; conversionFactor: number; pricePerBaseUnit: number
    stockOnHand: number; lastUpdated: unknown; location: string | null
    isActive: unknown; lastCountDate: unknown; lastCountQty: number | null
  }>('SELECT * FROM InventoryItem')
  console.log(`InventoryItem: ${items.length} rows`)
  for (const r of items) {
    await prisma.inventoryItem.upsert({
      where: { id: r.id },
      create: {
        id: r.id,
        itemName: r.itemName,
        category: r.category,
        supplierId: r.supplierId,
        storageAreaId: r.storageAreaId,
        purchaseUnit: r.purchaseUnit,
        qtyPerPurchaseUnit: r.qtyPerPurchaseUnit,
        purchasePrice: r.purchasePrice,
        baseUnit: r.baseUnit,
        packSize: r.packSize,
        packUOM: r.packUOM,
        countUOM: r.countUOM,
        conversionFactor: r.conversionFactor,
        pricePerBaseUnit: r.pricePerBaseUnit,
        stockOnHand: r.stockOnHand,
        lastUpdated: toDate(r.lastUpdated) ?? new Date(),
        location: r.location,
        isActive: toBool(r.isActive),
        lastCountDate: toDate(r.lastCountDate),
        lastCountQty: r.lastCountQty,
        // new PG fields — sensible defaults
        qtyUOM: 'each',
        priceType: 'CASE',
        allergens: [],
      },
      update: {
        itemName: r.itemName,
        category: r.category,
        stockOnHand: r.stockOnHand,
        pricePerBaseUnit: r.pricePerBaseUnit,
        purchasePrice: r.purchasePrice,
      },
    })
  }

  // ── 6. Recipe ─────────────────────────────────────────────────────────────
  // Build a set of valid InventoryItem IDs so we can null-out orphaned FKs
  const validItemIds = new Set(items.map(i => i.id))

  const recipes = query<{
    id: string; name: string; type: string; categoryId: string
    inventoryItemId: string | null; baseYieldQty: number; yieldUnit: string
    portionSize: number | null; portionUnit: string | null; menuPrice: number | null
    isActive: unknown; notes: string | null; createdAt: unknown; updatedAt: unknown
  }>('SELECT * FROM Recipe')
  console.log(`Recipe: ${recipes.length} rows`)
  for (const r of recipes) {
    await prisma.recipe.upsert({
      where: { id: r.id },
      create: {
        id: r.id,
        name: r.name,
        type: r.type,
        categoryId: r.categoryId,
        inventoryItemId: r.inventoryItemId && validItemIds.has(r.inventoryItemId) ? r.inventoryItemId : null,
        baseYieldQty: r.baseYieldQty,
        yieldUnit: r.yieldUnit,
        portionSize: r.portionSize,
        portionUnit: r.portionUnit,
        menuPrice: r.menuPrice,
        isActive: toBool(r.isActive),
        notes: r.notes,
        createdAt: toDate(r.createdAt) ?? new Date(),
        updatedAt: toDate(r.updatedAt) ?? new Date(),
      },
      update: { name: r.name, menuPrice: r.menuPrice, isActive: toBool(r.isActive) },
    })
  }

  // ── 7. RecipeIngredient ───────────────────────────────────────────────────
  const ingredients = query<{
    id: string; recipeId: string; inventoryItemId: string | null
    linkedRecipeId: string | null; qtyBase: number; unit: string
    sortOrder: number; notes: string | null; recipePercent: number | null
  }>('SELECT * FROM RecipeIngredient')
  console.log(`RecipeIngredient: ${ingredients.length} rows`)
  for (const r of ingredients) {
    await prisma.recipeIngredient.upsert({
      where: { id: r.id },
      create: {
        id: r.id,
        recipeId: r.recipeId,
        inventoryItemId: r.inventoryItemId,
        linkedRecipeId: r.linkedRecipeId,
        qtyBase: r.qtyBase,
        unit: r.unit,
        sortOrder: r.sortOrder ?? 0,
        notes: r.notes,
        recipePercent: r.recipePercent,
      },
      update: { qtyBase: r.qtyBase, unit: r.unit },
    })
  }

  // ── 8. SalesEntry ─────────────────────────────────────────────────────────
  const sales = query<{
    id: string; date: unknown; totalRevenue: number; foodSalesPct: number
    covers: number | null; notes: string | null; createdAt: unknown
  }>('SELECT * FROM SalesEntry')
  console.log(`SalesEntry: ${sales.length} rows`)
  for (const r of sales) {
    await prisma.salesEntry.upsert({
      where: { id: r.id },
      create: {
        id: r.id,
        date: toDate(r.date) ?? new Date(),
        totalRevenue: r.totalRevenue,
        foodSalesPct: r.foodSalesPct,
        covers: r.covers,
        notes: r.notes,
        createdAt: toDate(r.createdAt) ?? new Date(),
        periodType: 'day',
        // Legacy SQLite predates revenue centers; carry the row's RC if present.
        revenueCenterId: ((r as { revenueCenterId?: string | null }).revenueCenterId) ?? null,
      } as Parameters<typeof prisma.salesEntry.upsert>[0]['create'],
      update: { totalRevenue: r.totalRevenue },
    })
  }

  // ── 9. SaleLineItem ───────────────────────────────────────────────────────
  const saleLineItems = query<{ id: string; saleId: string; recipeId: string; qtySold: number }>(
    'SELECT * FROM SaleLineItem'
  )
  console.log(`SaleLineItem: ${saleLineItems.length} rows`)
  for (const r of saleLineItems) {
    await prisma.saleLineItem.upsert({
      where: { id: r.id },
      create: { id: r.id, saleId: r.saleId, recipeId: r.recipeId, qtySold: r.qtySold },
      update: { qtySold: r.qtySold },
    })
  }

  // ── 10. WastageLog ────────────────────────────────────────────────────────
  const wastageLogs = query<{
    id: string; inventoryItemId: string; date: unknown; qtyWasted: number
    unit: string; reason: string; costImpact: number; loggedBy: string; notes: string | null
  }>('SELECT * FROM WastageLog')
  console.log(`WastageLog: ${wastageLogs.length} rows`)
  for (const r of wastageLogs) {
    await prisma.wastageLog.upsert({
      where: { id: r.id },
      create: {
        id: r.id,
        inventoryItemId: r.inventoryItemId,
        date: toDate(r.date) ?? new Date(),
        qtyWasted: r.qtyWasted,
        unit: r.unit,
        reason: r.reason,
        costImpact: r.costImpact,
        loggedBy: r.loggedBy,
        notes: r.notes,
        // Legacy SQLite predates revenue centers; carry the row's RC if present.
        revenueCenterId: ((r as { revenueCenterId?: string | null }).revenueCenterId) ?? null,
      } as Parameters<typeof prisma.wastageLog.upsert>[0]['create'],
      update: {},
    })
  }

  // ── 11. Invoice ───────────────────────────────────────────────────────────
  const invoices = query<{
    id: string; supplierId: string; invoiceDate: unknown; invoiceNumber: string
    imageUrl: string | null; totalAmount: number; status: string; ocrRawData: string | null
    createdAt: unknown
  }>('SELECT * FROM Invoice')
  console.log(`Invoice: ${invoices.length} rows`)
  for (const r of invoices) {
    await prisma.invoice.upsert({
      where: { id: r.id },
      create: {
        id: r.id,
        supplierId: r.supplierId,
        invoiceDate: toDate(r.invoiceDate) ?? new Date(),
        invoiceNumber: r.invoiceNumber,
        imageUrl: r.imageUrl,
        totalAmount: r.totalAmount,
        status: r.status,
        ocrRawData: r.ocrRawData,
        createdAt: toDate(r.createdAt) ?? new Date(),
      },
      update: {},
    })
  }

  // ── 12. InvoiceLineItem ───────────────────────────────────────────────────
  const invoiceLineItems = query<{
    id: string; invoiceId: string; inventoryItemId: string; qtyPurchased: number
    unitPrice: number; lineTotal: number; priceOverride: number | null; rawDescription: string | null
  }>('SELECT * FROM InvoiceLineItem')
  console.log(`InvoiceLineItem: ${invoiceLineItems.length} rows`)
  for (const r of invoiceLineItems) {
    await prisma.invoiceLineItem.upsert({
      where: { id: r.id },
      create: {
        id: r.id,
        invoiceId: r.invoiceId,
        inventoryItemId: r.inventoryItemId,
        qtyPurchased: r.qtyPurchased,
        unitPrice: r.unitPrice,
        lineTotal: r.lineTotal,
        priceOverride: r.priceOverride,
        rawDescription: r.rawDescription,
      },
      update: {},
    })
  }

  // ── 13. CountSession ──────────────────────────────────────────────────────
  const countSessions = query<{
    id: string; sessionDate: unknown; label: string; type: string; areaFilter: string | null
    countedBy: string; status: string; startedAt: unknown; finalizedAt: unknown
    totalCountedValue: number; notes: string | null
  }>('SELECT * FROM CountSession')
  console.log(`CountSession: ${countSessions.length} rows`)
  for (const r of countSessions) {
    await prisma.countSession.upsert({
      where: { id: r.id },
      create: {
        id: r.id,
        sessionDate: toDate(r.sessionDate) ?? new Date(),
        label: r.label,
        type: r.type,
        areaFilter: r.areaFilter,
        countedBy: r.countedBy,
        status: r.status,
        startedAt: toDate(r.startedAt) ?? new Date(),
        finalizedAt: toDate(r.finalizedAt),
        totalCountedValue: r.totalCountedValue,
        notes: r.notes,
      },
      update: {},
    })
  }

  // ── 14. CountLine ─────────────────────────────────────────────────────────
  const countLines = query<{
    id: string; sessionId: string; inventoryItemId: string; expectedQty: number
    countedQty: number | null; selectedUom: string; skipped: unknown; variancePct: number | null
    varianceCost: number | null; priceAtCount: number; notes: string | null; sortOrder: number
  }>('SELECT * FROM CountLine')
  console.log(`CountLine: ${countLines.length} rows`)
  for (const r of countLines) {
    await prisma.countLine.upsert({
      where: { id: r.id },
      create: {
        id: r.id,
        sessionId: r.sessionId,
        inventoryItemId: r.inventoryItemId,
        expectedQty: r.expectedQty,
        countedQty: r.countedQty,
        selectedUom: r.selectedUom,
        skipped: toBool(r.skipped),
        variancePct: r.variancePct,
        varianceCost: r.varianceCost,
        priceAtCount: r.priceAtCount,
        notes: r.notes,
        sortOrder: r.sortOrder ?? 0,
      },
      update: {},
    })
  }

  // ── 15. InventorySnapshot ─────────────────────────────────────────────────
  const snapshots = query<{
    id: string; sessionId: string; inventoryItemId: string; snapshotDate: unknown
    qtyOnHand: number; unit: string; pricePerBaseUnit: number; totalValue: number; category: string
  }>('SELECT * FROM InventorySnapshot')
  console.log(`InventorySnapshot: ${snapshots.length} rows`)
  for (const r of snapshots) {
    await prisma.inventorySnapshot.upsert({
      where: { id: r.id },
      create: {
        id: r.id,
        sessionId: r.sessionId,
        inventoryItemId: r.inventoryItemId,
        snapshotDate: toDate(r.snapshotDate) ?? new Date(),
        qtyOnHand: r.qtyOnHand,
        unit: r.unit,
        pricePerBaseUnit: r.pricePerBaseUnit,
        totalValue: r.totalValue,
        category: r.category,
      },
      update: {},
    })
  }

  // ── 16. InvoiceSession ────────────────────────────────────────────────────
  const invoiceSessions = query<{
    id: string; status: string; supplierName: string | null; supplierId: string | null
    invoiceDate: string | null; invoiceNumber: string | null; subtotal: number | null
    tax: number | null; total: number | null; errorMessage: string | null
    approvedBy: string | null; approvedAt: unknown; createdAt: unknown
    parentSessionId: string | null
  }>('SELECT * FROM InvoiceSession')
  console.log(`InvoiceSession: ${invoiceSessions.length} rows`)
  // Insert non-clones first (no parentSessionId), then clones
  const sortedSessions = [
    ...invoiceSessions.filter(s => !s.parentSessionId),
    ...invoiceSessions.filter(s => !!s.parentSessionId),
  ]
  for (const r of sortedSessions) {
    await prisma.invoiceSession.upsert({
      where: { id: r.id },
      create: {
        id: r.id,
        status: r.status,
        supplierName: r.supplierName,
        supplierId: r.supplierId,
        invoiceDate: r.invoiceDate,
        invoiceNumber: r.invoiceNumber,
        subtotal: r.subtotal,
        tax: r.tax,
        total: r.total,
        errorMessage: r.errorMessage,
        approvedBy: r.approvedBy,
        approvedAt: toDate(r.approvedAt),
        createdAt: toDate(r.createdAt) ?? new Date(),
        parentSessionId: r.parentSessionId,
      },
      update: {},
    })
  }

  // ── 17. InvoiceFile ───────────────────────────────────────────────────────
  const invoiceFiles = query<{
    id: string; sessionId: string; fileName: string; fileType: string
    fileUrl: string; ocrStatus: string; ocrRawJson: string | null; createdAt: unknown
  }>('SELECT * FROM InvoiceFile')
  console.log(`InvoiceFile: ${invoiceFiles.length} rows`)
  for (const r of invoiceFiles) {
    await prisma.invoiceFile.upsert({
      where: { id: r.id },
      create: {
        id: r.id,
        sessionId: r.sessionId,
        fileName: r.fileName,
        fileType: r.fileType,
        fileUrl: r.fileUrl ?? '',
        ocrStatus: r.ocrStatus,
        ocrRawJson: r.ocrRawJson,
        createdAt: toDate(r.createdAt) ?? new Date(),
      },
      update: {},
    })
  }

  console.log('\n✅ Migration complete!')
}

main()
  .catch(e => { console.error('Migration failed:', e); process.exit(1) })
  .finally(() => prisma.$disconnect())
