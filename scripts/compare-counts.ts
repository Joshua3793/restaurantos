/**
 * Compare physical counts to explain a change in total stock value.
 *
 * Every count is re-valued at TODAY'S corrected prices, so a difference between
 * two counts is a difference in QUANTITY, not in pricing. The as-counted totals
 * are reported alongside so the price effect is visible separately.
 *
 * For a month-end split across sessions (PREPD one night, the rest the next),
 * pass them joined by '+' to merge them into one position: each item takes its
 * most recent physical observation across that group.
 *
 *   scripts/compare-counts.ts <idA> <idB+idC> ...
 *
 * READ-ONLY.
 */
import { prisma } from '../src/lib/prisma'
import { asChainItem, pricePerBaseUnit } from '../src/lib/item-model'

const GROUPS = process.argv.slice(2).map((g) => g.split('+').map((s) => s.trim()).filter(Boolean))

type Position = {
  label: string
  date: string
  qty: Map<string, number>          // itemId -> base qty
  physical: Set<string>             // itemId physically counted somewhere in the group
  asCounted: number
}

async function buildPosition(ids: string[]): Promise<Position> {
  const sessions = await prisma.countSession.findMany({ where: { id: { in: ids } }, orderBy: { sessionDate: 'asc' } })
  const dateOf = new Map(sessions.map((s) => [s.id, s.sessionDate.getTime()]))
  const lines = await prisma.countLine.findMany({ where: { sessionId: { in: ids } } })
  const snaps = await prisma.inventorySnapshot.findMany({ where: { sessionId: { in: ids } } })

  const qty = new Map<string, number>()
  const physical = new Set<string>()
  const byItem = new Map<string, typeof lines>()
  for (const l of lines) {
    const arr = byItem.get(l.inventoryItemId) ?? []
    arr.push(l); byItem.set(l.inventoryItemId, arr)
  }
  for (const [itemId, arr] of byItem) {
    arr.sort((a, b) => dateOf.get(b.sessionId)! - dateOf.get(a.sessionId)!)
    const phys = arr.find((l) => !l.skipped && l.countedQty !== null)
    const pick = phys ?? arr[0]
    if (phys) physical.add(itemId)
    // The snapshot is the historical record of what was on the shelf; pack
    // chains have been repaired since, so re-resolving the counter's entry
    // through a corrected chain would answer a different question.
    const snap = snaps
      .filter((s) => s.inventoryItemId === itemId)
      .sort((a, b) => dateOf.get(b.sessionId)! - dateOf.get(a.sessionId)!)
      .find((s) => s.sessionId === pick.sessionId) ??
      snaps.filter((s) => s.inventoryItemId === itemId)
        .sort((a, b) => dateOf.get(b.sessionId)! - dateOf.get(a.sessionId)!)[0]
    qty.set(itemId, snap ? Number(snap.qtyOnHand) : 0)
  }
  return {
    label: sessions.map((s) => s.label).join(' + '),
    date: sessions[sessions.length - 1].sessionDate.toISOString().slice(0, 10),
    qty, physical,
    asCounted: sessions.reduce((t, s) => t + Number(s.totalCountedValue), 0),
  }
}

async function main() {
  if (GROUPS.length < 2) { console.error('Give at least two counts to compare'); process.exit(1) }

  const items = await prisma.inventoryItem.findMany()
  const price = new Map<string, number>()
  const meta = new Map<string, { name: string; cat: string }>()
  for (const it of items) {
    price.set(it.id, pricePerBaseUnit(asChainItem(it)))
    meta.set(it.id, { name: it.itemName, cat: it.category })
  }

  const positions: Position[] = []
  for (const g of GROUPS) positions.push(await buildPosition(g))

  const valueOf = (p: Position) => [...p.qty.entries()]
    .reduce((t, [id, q]) => t + q * (price.get(id) ?? 0), 0)

  console.log('Every count re-valued at TODAY\'S corrected prices, so differences are QUANTITY, not price.\n')
  console.log('date        items  physically   as counted   at current prices   label')
  for (const p of positions) {
    console.log(
      p.date.padEnd(11),
      String(p.qty.size).padStart(5),
      String(p.physical.size).padStart(11),
      ('$' + p.asCounted.toFixed(2)).padStart(13),
      ('$' + valueOf(p).toFixed(2)).padStart(19),
      ' ', p.label,
    )
  }

  // Walk each consecutive pair and attribute the movement.
  for (let i = 1; i < positions.length; i++) {
    const a = positions[i - 1], b = positions[i]
    const va = valueOf(a), vb = valueOf(b)
    console.log(`\n${'─'.repeat(78)}\n${a.date} → ${b.date}   $${va.toFixed(2)} → $${vb.toFixed(2)}   (${(vb - va >= 0 ? '+' : '')}$${(vb - va).toFixed(2)} at constant prices)\n`)

    const ids = new Set([...a.qty.keys(), ...b.qty.keys()])
    const moves: Array<{ id: string; d: number; qa: number; qb: number; newItem: boolean; gone: boolean }> = []
    for (const id of ids) {
      const qa = a.qty.get(id) ?? 0, qb = b.qty.get(id) ?? 0
      const p = price.get(id) ?? 0
      const d = (qb - qa) * p
      if (Math.abs(d) < 1) continue
      moves.push({ id, d, qa, qb, newItem: !a.qty.has(id), gone: !b.qty.has(id) })
    }
    moves.sort((x, y) => y.d - x.d)

    const up = moves.filter((m) => m.d > 0), down = moves.filter((m) => m.d < 0)
    console.log(`  ${up.length} items up  $${up.reduce((t, m) => t + m.d, 0).toFixed(2)}   |   ${down.length} items down  $${down.reduce((t, m) => t + m.d, 0).toFixed(2)}`)
    const newOnes = moves.filter((m) => m.newItem)
    if (newOnes.length) console.log(`  of which NOT on the earlier count sheet: ${newOnes.length} items, $${newOnes.reduce((t, m) => t + m.d, 0).toFixed(2)}`)

    const byCat = new Map<string, number>()
    for (const m of moves) {
      const c = meta.get(m.id)?.cat ?? '?'
      byCat.set(c, (byCat.get(c) ?? 0) + m.d)
    }
    console.log('\n  by category:')
    ;[...byCat.entries()].sort((x, y) => y[1] - x[1]).forEach(([c, v]) =>
      console.log(`    ${c.padEnd(8)} ${(v >= 0 ? '+' : '') + '$' + v.toFixed(2)}`))

    console.log('\n  biggest increases:')
    up.slice(0, 12).forEach((m) => {
      const x = meta.get(m.id)!
      console.log(`    +$${m.d.toFixed(2).padStart(8)}  ${x.name.slice(0, 34).padEnd(35)} ${m.qa.toFixed(0)} → ${m.qb.toFixed(0)}${m.newItem ? '   (new on sheet)' : ''}`)
    })
    console.log('\n  biggest decreases:')
    down.slice(-8).reverse().forEach((m) => {
      const x = meta.get(m.id)!
      console.log(`    -$${Math.abs(m.d).toFixed(2).padStart(8)}  ${x.name.slice(0, 34).padEnd(35)} ${m.qa.toFixed(0)} → ${m.qb.toFixed(0)}${m.gone ? '   (off sheet)' : ''}`)
    })
  }
  await prisma.$disconnect()
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
