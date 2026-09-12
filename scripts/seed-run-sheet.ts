// scripts/seed-run-sheet.ts
// One-shot, idempotent seed for the Prep To-Do → Run Sheet redesign.
//
// Seed default services: for each active RevenueCenter with zero Service
// rows, create Lunch (timeMinutes: 690, sortOrder: 0) and Dinner
// (timeMinutes: 1020, sortOrder: 1), both isActive: true.
//
// Safe to run repeatedly — every write is guarded by a pre-check, so a second
// run reports zero changes.
//
// Run: npx tsx scripts/seed-run-sheet.ts

import { prisma } from '../src/lib/prisma'

async function seedDefaultServices() {
  const activeRCs = await prisma.revenueCenter.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
  })

  let seeded = 0
  let skippedHasServices = 0

  for (const rc of activeRCs) {
    const existingCount = await prisma.service.count({ where: { revenueCenterId: rc.id } })
    if (existingCount > 0) {
      skippedHasServices++
      continue
    }

    await prisma.service.createMany({
      data: [
        { revenueCenterId: rc.id, name: 'Lunch', timeMinutes: 690, sortOrder: 0, isActive: true },
        { revenueCenterId: rc.id, name: 'Dinner', timeMinutes: 1020, sortOrder: 1, isActive: true },
      ],
    })
    seeded++
    console.log(`[SEEDED] ${rc.name}  → Lunch (690), Dinner (1020)`)
  }

  console.log('\n──────── default service seed ────────')
  console.log(`active RCs scanned:              ${activeRCs.length}`)
  console.log(`RCs seeded:                      ${seeded}`)
  console.log(`RCs skipped (already had svcs):  ${skippedHasServices}`)

  return { seeded, skippedHasServices }
}

async function main() {
  console.log('Seed run sheet — seed default services\n')

  const serviceResult = await seedDefaultServices()

  console.log('\n──────── summary ────────')
  console.log(`RCs seeded:            ${serviceResult.seeded}`)

  const totalChanges = serviceResult.seeded
  console.log(totalChanges === 0 ? '\nNo changes — already up to date (idempotent).' : `\n${totalChanges} total write(s) applied.`)
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
