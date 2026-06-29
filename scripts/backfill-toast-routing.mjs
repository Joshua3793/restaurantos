// scripts/backfill-toast-routing.mjs
// Backfill for location-aware Toast routing (T17).
//
// 1. For each Location, set defaultRevenueCenterId to its FOOD-typed RC
//    (prefer isDefault=true, else oldest by createdAt). Idempotent.
// 2. Re-point the 3 Toast café RC GUIDs to the CAFE location:
//    set locationId = CAFE.id, revenueCenterId = null.
//    (menu: sentinel rows are left untouched.)
//
// Run: set -a; . ./.env; set +a; node scripts/backfill-toast-routing.mjs

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const CAFE_GUIDS = [
  '3459ef85-27ff-4cc7-a62d-7a0d90b9bb70',
  '212406cd-22bf-4cc2-9c86-9fc490163140',
  'b853f7e2-048b-4c21-8f16-ebd90b98df61',
]

async function main() {
  // ---- Step 1: location default RCs ----
  const locations = await prisma.location.findMany({
    include: { revenueCenters: true },
  })

  console.log('=== BEFORE: location defaults ===')
  for (const loc of locations) {
    console.log(`  ${loc.name} (${loc.id}) defaultRevenueCenterId=${loc.defaultRevenueCenterId ?? 'null'}`)
  }

  for (const loc of locations) {
    if (loc.defaultRevenueCenterId) {
      console.log(`skip (already set): ${loc.name} -> ${loc.defaultRevenueCenterId}`)
      continue
    }
    const foodRcs = loc.revenueCenters.filter((rc) => rc.type === 'FOOD')
    if (foodRcs.length === 0) {
      console.log(`WARN: ${loc.name} has no FOOD-typed RC; leaving default null`)
      continue
    }
    const chosen =
      foodRcs.find((rc) => rc.isDefault) ??
      foodRcs.slice().sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0]
    await prisma.location.update({
      where: { id: loc.id },
      data: { defaultRevenueCenterId: chosen.id },
    })
    console.log(`set: ${loc.name} default -> ${chosen.name} (${chosen.id})`)
  }

  // ---- Step 2: re-point café Toast GUIDs to CAFE location ----
  // Find CAFE location: by name, cross-checked it contains a KITCHEN RC.
  const cafe =
    locations.find((l) => l.name === 'CAFE') ??
    locations.find((l) => l.isDefault)
  if (!cafe) throw new Error('CAFE location not found')
  const hasKitchen = cafe.revenueCenters.some((rc) => rc.name === 'KITCHEN')
  console.log(`\nCAFE location = ${cafe.name} (${cafe.id}); contains KITCHEN? ${hasKitchen}`)
  if (!hasKitchen) throw new Error('Resolved CAFE location does not contain a KITCHEN RC; aborting')

  console.log('\n=== BEFORE: café Toast map rows ===')
  const before = await prisma.toastRevenueCenterMap.findMany({
    where: { toastGuid: { in: CAFE_GUIDS } },
  })
  for (const r of before) {
    console.log(`  ${r.toastGuid} locationId=${r.locationId ?? 'null'} revenueCenterId=${r.revenueCenterId ?? 'null'}`)
  }

  const upd = await prisma.toastRevenueCenterMap.updateMany({
    where: { toastGuid: { in: CAFE_GUIDS } },
    data: { locationId: cafe.id, revenueCenterId: null },
  })
  console.log(`\nupdated ${upd.count} café Toast map rows`)

  // ---- AFTER ----
  console.log('\n=== AFTER: location defaults ===')
  const locAfter = await prisma.location.findMany()
  for (const loc of locAfter) {
    console.log(`  ${loc.name} (${loc.id}) defaultRevenueCenterId=${loc.defaultRevenueCenterId ?? 'null'}`)
  }

  console.log('\n=== AFTER: café Toast map rows ===')
  const after = await prisma.toastRevenueCenterMap.findMany({
    where: { toastGuid: { in: CAFE_GUIDS } },
  })
  for (const r of after) {
    console.log(`  ${r.toastGuid} locationId=${r.locationId ?? 'null'} revenueCenterId=${r.revenueCenterId ?? 'null'}`)
  }

  console.log('\n=== menu: sentinel rows (should be unchanged) ===')
  const sentinels = await prisma.toastRevenueCenterMap.findMany({
    where: { toastGuid: { startsWith: 'menu:' } },
  })
  for (const r of sentinels) {
    console.log(`  ${r.toastGuid} locationId=${r.locationId ?? 'null'} revenueCenterId=${r.revenueCenterId ?? 'null'}`)
  }
}

main()
  .then(() => prisma.$disconnect().then(() => process.exit(0)))
  .catch((e) => {
    console.error(e)
    prisma.$disconnect().finally(() => process.exit(1))
  })
