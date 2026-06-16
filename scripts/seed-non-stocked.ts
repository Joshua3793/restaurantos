/**
 * Flag recipe-only utility ingredients as non-stocked (isStocked=false) and sanitize
 * their UOM so they stop showing as degenerate containers. Non-stocked items stay
 * usable in recipes at $0 but drop out of counts / valuation / purchasing / theoretical
 * stock (those readers now filter isStocked:true).
 *
 * Dry-run by default; APPLY=1 writes. Idempotent.
 */
import { prisma } from '../src/lib/prisma'

// id → desired sane config for a non-stocked utility ingredient.
const SEEDS: { id: string; name: string; baseUnit: string; countUOM: string }[] = [
  { id: 'cba7ab9431b2142e3899bff5', name: 'Water', baseUnit: 'ml', countUOM: 'ml' }, // tap water — costed at $0 in recipes
]

const APPLY = process.env.APPLY === '1'

async function main() {
  for (const s of SEEDS) {
    const before = await prisma.inventoryItem.findUnique({
      where: { id: s.id },
      select: { itemName: true, isStocked: true, purchaseUnit: true, packUOM: true, packSize: true, qtyUOM: true, baseUnit: true, countUOM: true, pricePerBaseUnit: true },
    })
    if (!before) { console.log(`  ! ${s.name} (${s.id}) not found — skipped`); continue }
    const data = {
      isStocked: false,
      pricePerBaseUnit: 0,
      baseUnit: s.baseUnit,
      countUOM: s.countUOM,
      qtyUOM: s.baseUnit,   // measured by its base unit; no pack structure
      purchaseUnit: 'each', // drop the degenerate 'case (1 ml)' artifact
      packUOM: 'each',
      packSize: 1,
    }
    console.log(`  ${s.name} (${s.id})`)
    console.log(`    before: ${JSON.stringify(before)}`)
    console.log(`    after : ${JSON.stringify(data)}`)
    if (APPLY) await prisma.inventoryItem.update({ where: { id: s.id }, data })
  }
  console.log(`\n${APPLY ? 'APPLIED' : 'DRY-RUN'} — ${SEEDS.length} item(s). ${APPLY ? '' : 'Re-run with APPLY=1 to write.'}`)
  await prisma.$disconnect()
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
