/**
 * Seeds one finalized count session with realistic data.
 * Run with: npx ts-node --compiler-options '{"module":"commonjs"}' prisma/seed-count.ts
 * or: npx tsx prisma/seed-count.ts
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  // Get all active items
  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true },
    orderBy: [{ category: 'asc' }, { itemName: 'asc' }],
    take: 50,
  })

  if (items.length === 0) {
    console.log('No active inventory items found. Add items first.')
    return
  }

  const sessionDate = new Date()
  sessionDate.setDate(sessionDate.getDate() - 7) // 1 week ago
  const finalizedAt = new Date(sessionDate)
  finalizedAt.setHours(finalizedAt.getHours() + 2)

  console.log(`Seeding count session for ${items.length} items...`)

  // Build lines with slightly varied counts (±10% variance to make it realistic)
  const lineData = items.map(item => {
    const expected = Number(item.stockOnHand)
    // Simulate ~80% of items matching, ~20% with minor variance
    const variance = Math.random() < 0.8 ? 0 : (Math.random() - 0.5) * expected * 0.2
    const counted = Math.max(0, expected + variance)
    const countedRounded = Math.round(counted * 100) / 100
    const v = countedRounded - expected
    const variancePct = expected > 0 ? (v / expected) * 100 : 0
    const varianceCost = v * Number(item.pricePerBaseUnit)
    return {
      inventoryItemId: item.id,
      expectedQty: expected,
      countedQty: countedRounded,
      selectedUom: item.countUOM,
      priceAtCount: item.pricePerBaseUnit,
      variancePct,
      varianceCost,
    }
  })

  const totalCountedValue = lineData.reduce((s, l) => {
    const item = items.find(i => i.id === l.inventoryItemId)!
    return s + l.countedQty * Number(item.conversionFactor) * Number(item.pricePerBaseUnit)
  }, 0)

 const session = await prisma.countSession.create({
  data: {
    label: 'Sample full inventory count',
    sessionDate,
    type: 'FULL',
    status: 'FINALIZED',
    countedBy: 'System Seed',
    totalCountedValue,
    startedAt: sessionDate,
    finalizedAt,
    notes: 'Sample seeded count session',
    lines: {
      create: lineData.map((line) => ({
        inventoryItem: {
          connect: { id: line.inventoryItemId },
        },
        selectedUom: line.selectedUom,
        expectedQty: line.expectedQty,
        countedQty: line.countedQty,
        priceAtCount: Number(line.priceAtCount),
        variancePct: line.variancePct,
        varianceCost: line.varianceCost,
      })),
    },
  },
})
  // Create snapshots
  const snapshots = items.map(item => {
    const line = lineData.find(l => l.inventoryItemId === item.id)!
    return {
      sessionId: session.id,
      inventoryItemId: item.id,
      snapshotDate: finalizedAt,
      qtyOnHand: line.countedQty,
      unit: item.countUOM,
      pricePerBaseUnit: item.pricePerBaseUnit,
      totalValue: line.countedQty * Number(item.conversionFactor) * Number(item.pricePerBaseUnit),
      category: item.category,
    }
  })

  await prisma.inventorySnapshot.createMany({ data: snapshots })

  console.log(`✓ Created count session: ${session.id}`)
  console.log(`  Date: ${sessionDate.toLocaleDateString()}`)
  console.log(`  Items: ${lineData.length}`)
  console.log(`  Total value: $${totalCountedValue.toFixed(2)}`)
  console.log(`  Snapshots: ${snapshots.length}`)
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
