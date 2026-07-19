// scripts/seed-run-sheet.ts
// One-shot, idempotent backfill + seed for the Prep To-Do → Run Sheet redesign.
//
// (a) Backfill prep times: for each PrepItem where estimatedPrepTime != null,
//     its linked recipe (if any) has no activeMinutes, AND activeMinutesOverride
//     is still null, set activeMinutesOverride = estimatedPrepTime. Never
//     overwrites an existing override; never touches items that already resolve
//     an active time from their linked recipe.
//
// (b) Seed default services: for each active RevenueCenter with zero Service
//     rows, create Lunch (timeMinutes: 690, sortOrder: 0) and Dinner
//     (timeMinutes: 1020, sortOrder: 1), both isActive: true.
//
// Safe to run repeatedly — every write is guarded by a pre-check, so a second
// run reports zero changes.
//
// Run: npx tsx scripts/seed-run-sheet.ts

import { prisma } from '../src/lib/prisma'

async function backfillPrepTimes() {
  const candidates = await prisma.prepItem.findMany({
    where: {
      estimatedPrepTime: { not: null },
      activeMinutesOverride: null,
    },
    select: {
      id: true,
      name: true,
      estimatedPrepTime: true,
      linkedRecipe: { select: { activeMinutes: true } },
    },
  })

  let backfilled = 0
  let skippedResolved = 0

  for (const item of candidates) {
    const recipeActiveMinutes = item.linkedRecipe?.activeMinutes ?? null
    if (recipeActiveMinutes != null) {
      // Already resolves an active time from its recipe — don't touch it.
      skippedResolved++
      continue
    }

    await prisma.prepItem.update({
      where: { id: item.id },
      data: { activeMinutesOverride: item.estimatedPrepTime },
    })
    backfilled++
    console.log(`[BACKFILLED] ${item.name}  activeMinutesOverride = ${item.estimatedPrepTime}`)
  }

  console.log('\n──────── prep time backfill ────────')
  console.log(`candidates scanned:              ${candidates.length}`)
  console.log(`backfilled (override set):       ${backfilled}`)
  console.log(`skipped (resolves from recipe):  ${skippedResolved}`)

  return { backfilled, skippedResolved }
}

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
  console.log('Seed run sheet — backfill prep times + seed default services\n')

  const prepResult = await backfillPrepTimes()
  const serviceResult = await seedDefaultServices()

  console.log('\n──────── summary ────────')
  console.log(`prep items backfilled: ${prepResult.backfilled}`)
  console.log(`RCs seeded:            ${serviceResult.seeded}`)

  const totalChanges = prepResult.backfilled + serviceResult.seeded
  console.log(totalChanges === 0 ? '\nNo changes — already up to date (idempotent).' : `\n${totalChanges} total write(s) applied.`)
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
