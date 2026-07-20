// scripts/backfill-locations.ts
// Backfills one Location per existing RevenueCenter ("auto-wrap" — zero
// operational-data movement). For each RC without a locationId: create a
// mirroring Location, point the RC at it, set RC.type = 'FOOD' and copy
// targetFoodCostPct → targetCostPct. Idempotent: skips RCs already wrapped.
//
// Run: npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/backfill-locations.ts

import { prisma } from '../src/lib/prisma'

async function main() {
  const rcs = await prisma.revenueCenter.findMany()
  let wrapped = 0
  let skipped = 0
  for (const rc of rcs) {
    if (rc.locationId) {
      skipped++
      continue // idempotent
    }
    await prisma.$transaction(async (tx) => {
      const loc = await tx.location.create({
        data: {
          name: rc.name,
          color: rc.color,
          // existing RC.type holds OLD vocab (restaurant|catering|events|retail|other);
          // Location inherits a sensible org type: catering→catering, else→restaurant
          type: rc.type === 'catering' ? 'catering' : 'restaurant',
          isDefault: rc.isDefault, // Location.isDefault mirrors the default-stock-pool RC
          managerName: rc.managerName,
          notes: rc.notes,
          description: rc.description,
          // schedulingMode / serviceSchedule are no longer seeded from the RC:
          // both columns were dropped from RevenueCenter once service type + hours
          // moved to the Service model. Location keeps its own (now unread) copies.
          prepLeadMinutes: rc.prepLeadMinutes,
          isActive: rc.isActive,
        },
      })
      await tx.revenueCenter.update({
        where: { id: rc.id },
        data: {
          locationId: loc.id,
          type: 'FOOD', // existing RCs become FOOD leaves
          targetCostPct: rc.targetFoodCostPct ?? undefined,
        },
      })
    })
    console.log(`wrapped RC ${rc.name} → Location`)
    wrapped++
  }
  console.log(`done — ${wrapped} wrapped, ${skipped} skipped (already had locationId)`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
