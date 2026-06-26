/**
 * Normalize stale InventoryItem.countUnit hints that aren't a chain level or a
 * same-dimension unit (so they fail validateChainItem and fall back at read time).
 *
 * Sets countUnit = resolveCountUom(item) — the valid unit the count UI already
 * resolves to (a chain level, normally the leaf). Zero behavior change; it just
 * persists the resolved value so the stored hint is valid and self-describing.
 *
 * Dry by default; pass --apply to write.
 */
import { prisma } from '../src/lib/prisma'
import { resolveCountUom } from '../src/lib/count-uom'
import { asChainItem, validateChainItem } from '../src/lib/item-model'

const APPLY = process.argv.includes('--apply')

async function main() {
  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true },
    select: { id: true, itemName: true, dimension: true, baseUnit: true, packChain: true, countUnit: true },
  })
  const bad = items.filter(i => validateChainItem(asChainItem(i as any)).some(e => e.includes('countUnit')))

  let fixed = 0
  for (const i of bad) {
    const resolved = resolveCountUom(i as any)
    // Safety: the new value must itself be valid for this item.
    const stillBad = validateChainItem({ ...asChainItem(i as any), countUnit: resolved }).some(e => e.includes('countUnit'))
    if (!resolved || stillBad) { console.log(`SKIP ${i.itemName}: resolved="${resolved}" still invalid`); continue }
    fixed++
    console.log(`${i.itemName}: countUnit "${i.countUnit}" -> "${resolved}"`)
    if (APPLY) await prisma.inventoryItem.update({ where: { id: i.id }, data: { countUnit: resolved } })
  }
  console.log(`\n${fixed} item(s) ${APPLY ? 'NORMALIZED' : 'would be normalized (dry run)'}.`)
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
