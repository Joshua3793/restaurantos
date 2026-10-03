// Read-only. For every active, stocked item: how many movements since its last
// count the bridges could not convert, what the theoretical on-hand is now
// (this branch), and what it was under the old 1:1 passthrough. Prints the
// items that changed, most-changed first, and a one-line total. A second
// section lists the weight<->volume items that have a density set (those now
// convert through density, so their theoretical may have moved too).
//
// Run: TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/audit-unbridged-movements.ts
import { prisma } from '../src/lib/prisma'
import { getTheoreticalBalanceMap, type LedgerEvent } from '../src/lib/count-expected'
import { isKnownUnit } from '../src/lib/uom'

async function main() {
  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true, isStocked: true },
    select: { id: true, itemName: true, baseUnit: true, eachMeasureQty: true, eachMeasureUnit: true, densityGPerMl: true },
  })
  const byId = new Map(items.map(i => [i.id, i]))
  const events: LedgerEvent[] = []
  const after = await getTheoreticalBalanceMap(null, undefined, null, { sink: { push: e => { if (e.unbridged && byId.has(e.itemId)) events.push(e) } } })

  const perItem = new Map<string, { count: number; oldDelta: number; units: Set<string> }>()
  for (const e of events) {
    const cur = perItem.get(e.itemId) ?? { count: 0, oldDelta: 0, units: new Set<string>() }
    cur.count++
    // The old engine passed the quantity through 1:1 in the item's base unit, with the event's sign.
    // PURCHASE/TRANSFER never go through movementQtyBase (purchases freeze receivedQtyBase); listed for completeness.
    const sign = e.type === 'PREP_OUT' || e.type === 'PURCHASE' ? 1 : -1
    cur.oldDelta += sign * e.unbridged!.qty
    const unit = e.unbridged!.unit
    cur.units.add(isKnownUnit(unit) ? unit : `${unit} (unknown unit)`)
    perItem.set(e.itemId, cur)
  }

  const rows = Array.from(perItem.entries()).map(([id, v]) => {
    const it = byId.get(id)!
    const now = after.get(id)?.expected ?? 0
    const before = Math.max(0, now + v.oldDelta)
    return { name: it.itemName, base: it.baseUnit, bridge: it.eachMeasureQty ? `${it.eachMeasureQty} ${it.eachMeasureUnit}` : '—', count: v.count, units: [...v.units].join('/'), before, now }
  }).sort((a, b) => Math.abs(b.before - b.now) - Math.abs(a.before - a.now))

  console.log(`Movements since each item's last count that the item's bridges cannot convert — "before" is what the old 1:1 passthrough would have shown, "now" is this branch:`)
  if (rows.length === 0) console.log('(none — every movement since the last counts converted cleanly)')
  for (const r of rows) {
    console.log(`${r.name.padEnd(40)} ${String(r.count).padStart(3)} lines in ${r.units.padEnd(20)} bridge ${r.bridge.padEnd(10)} before ${r.before.toFixed(2)} ${r.base} → now ${r.now.toFixed(2)} ${r.base}`)
  }
  console.log(`${rows.length} items had unbridged movements (${events.length} lines); ${items.length} active stocked items checked`)

  const dense = items.filter(i => i.densityGPerMl != null).sort((a, b) => a.itemName.localeCompare(b.itemName))
  console.log('')
  console.log('Weight↔volume items with a density set (now converted through density; previously 1:1):')
  console.log('(only items with a weight↔volume movement since their last count actually moved; a round "now" figure usually means no movement)')
  for (const i of dense) {
    const now = after.get(i.id)?.expected ?? 0
    console.log(`${i.itemName.padEnd(40)} density ${String(Number(i.densityGPerMl)).padStart(6)} g/ml   theoretical now ${now.toFixed(2)} ${i.baseUnit}`)
  }
  console.log(`${dense.length} items have a density set`)
}

main().catch(e => { console.error(e); process.exitCode = 1 }).finally(() => prisma.$disconnect())
