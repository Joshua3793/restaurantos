/**
 * One-off, idempotent backfill for the prep run-sheet's timing inputs.
 *
 * Two things were true before this ran:
 *   1. `PrepItem.targetServiceId` had NO write path anywhere in the app, so every
 *      item had a null service. `startByMinutes` therefore returned null for all of
 *      them and the run sheet's time ladder collapsed into one catch-all bucket.
 *   2. `estimatedPrepTime` (legacy) held the only authored duration, but
 *      `resolveActive` reads `activeMinutesOverride ?? linkedRecipe.activeMinutes`
 *      and deliberately does NOT fall back to it — so those minutes were invisible
 *      to the ladder.
 *
 * This script fixes both, without inventing data:
 *   - targetServiceId  ← the item's RC's single active service. Every prep item in
 *                        this database is Shared (revenueCenterId null), so the
 *                        practical path is the DEFAULT RC's single active service —
 *                        a Shared item is prepped in the main kitchen and must be
 *                        ready for its service. Skipped when the resolved RC has
 *                        zero or MORE THAN ONE active service: with several, "which
 *                        one" is a judgement call a human must make, and guessing
 *                        would silently mis-schedule real prep.
 *   - activeMinutesOverride ← estimatedPrepTime, ONLY when the item has no override
 *                        and no linked-recipe activeMinutes to inherit. Never
 *                        overwrites an authored value.
 *
 * Idempotent: every update is guarded on the target field still being null, so
 * re-running is a no-op. Pass --dry to preview without writing.
 *
 * Usage:  npx tsx scripts/backfill-prep-timing.ts [--dry]
 */
import { prisma } from '@/lib/prisma'

const DRY = process.argv.includes('--dry')

async function main() {
  const items = await prisma.prepItem.findMany({
    where: { isActive: true },
    select: {
      id: true,
      name: true,
      revenueCenterId: true,
      targetServiceId: true,
      estimatedPrepTime: true,
      activeMinutesOverride: true,
      linkedRecipe: { select: { activeMinutes: true } },
    },
  })

  // Active services per RC, resolved once rather than per item.
  const services = await prisma.service.findMany({
    where: { isActive: true },
    select: { id: true, name: true, revenueCenterId: true, timeMinutes: true },
    orderBy: [{ sortOrder: 'asc' }, { timeMinutes: 'asc' }],
  })
  // Shared items (revenueCenterId null) resolve against the default RC.
  const defaultRc = await prisma.revenueCenter.findFirst({
    where: { isDefault: true, isActive: true },
    select: { id: true, name: true },
  })
  const byRc = new Map<string, typeof services>()
  for (const s of services) {
    const list = byRc.get(s.revenueCenterId) ?? []
    list.push(s)
    byRc.set(s.revenueCenterId, list)
  }

  let svcSet = 0, svcSkippedNoRc = 0, svcSkippedAmbiguous = 0, svcAlready = 0
  let minsSet = 0, minsAlready = 0, minsNoSource = 0

  for (const it of items) {
    const patch: { targetServiceId?: string; activeMinutesOverride?: number } = {}

    // ── target service ──────────────────────────────────────────────────────
    // A Shared item has no RC of its own, so it inherits the default RC's service.
    const rcId = it.revenueCenterId ?? defaultRc?.id ?? null
    if (it.targetServiceId) {
      svcAlready++
    } else if (!rcId) {
      svcSkippedNoRc++
    } else {
      const candidates = byRc.get(rcId) ?? []
      if (candidates.length === 1) {
        patch.targetServiceId = candidates[0].id
        svcSet++
      } else {
        svcSkippedAmbiguous++
      }
    }

    // ── hands-on minutes ────────────────────────────────────────────────────
    if (it.activeMinutesOverride != null) {
      minsAlready++
    } else if (it.linkedRecipe?.activeMinutes != null) {
      // Already inherits a real value from its recipe — leave it inheriting.
      minsAlready++
    } else if (it.estimatedPrepTime != null) {
      patch.activeMinutesOverride = it.estimatedPrepTime
      minsSet++
    } else {
      minsNoSource++
    }

    if (Object.keys(patch).length === 0) continue
    if (DRY) {
      console.log(`  ${it.name}: ${JSON.stringify(patch)}`)
    } else {
      await prisma.prepItem.update({ where: { id: it.id }, data: patch })
    }
  }

  console.log(`\n${DRY ? '[DRY RUN] ' : ''}Backfill over ${items.length} active prep items`)
  console.log(`  default RC for Shared items: ${defaultRc ? defaultRc.name : '(none — Shared items skipped)'}`)
  console.log(`  targetServiceId  set=${svcSet} already=${svcAlready} skipped(no RC)=${svcSkippedNoRc} skipped(ambiguous)=${svcSkippedAmbiguous}`)
  console.log(`  handsOn minutes  set=${minsSet} already/inherited=${minsAlready} no source=${minsNoSource}`)
  if (svcSkippedAmbiguous > 0) {
    console.log(`\n  NOTE: ${svcSkippedAmbiguous} item(s) sit on an RC with multiple active services.`)
    console.log(`  Pick their service by hand in the prep item drawer — guessing would mis-schedule real prep.`)
  }

  await prisma.$disconnect()
}

main().catch(async e => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
