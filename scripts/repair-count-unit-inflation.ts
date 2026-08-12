/**
 * Repair the stock inflated by a count unit that was silently resolved through the pack
 * chain, and stop count lines from re-deriving a different quantity than the count they
 * belong to actually banked.
 *
 *   npx tsx scripts/repair-count-unit-inflation.ts            # report only
 *   npx tsx scripts/repair-count-unit-inflation.ts --apply     # write
 *
 * BACKGROUND. `resolveUnitBase` used to map an unrecognised unit onto a pack level —
 * "each" → the chain leaf, and any same-dimension name it didn't know → the leaf too. On
 * a SINGLE-link chain the leaf IS the case, so a by-weight item counted in a stale
 * COUNT-era "each" multiplied by the whole case:
 *
 *   peaches, 1 Aug: "25 each" → 25 × 9,071.84 g = 226.8 kg, $1,575 of stock that was
 *   never in the building. The item itself declared 1 each = 150 g (3.75 kg, $26.04).
 *
 * The resolver fix stops that recurring; assertCountableUom now refuses such a unit at
 * write and at finalize. This script cleans up what the old resolver already stored.
 *
 * SCOPE. It REPAIRS exactly the lines whose bad conversion is still driving a live number,
 * and only AUDITS the rest. For a live fix the frozen InventorySnapshot is the source of
 * truth for what the count actually banked — never a re-derivation through today's chain,
 * which has since been repaired under many items.
 *
 * It deliberately does NOT reconcile the 75 historical lines whose re-derived quantity no
 * longer matches their own snapshot ($44k of disagreement). A first version of this script
 * pinned each line to its snapshot; the dry run showed why that is wrong. All 313 snapshot
 * rows on the 1 Apr count are UNCONVERTED — "3 kg" of parmigiano was banked as 3 g, and the
 * session totals $75.71 for a 313-line full count — so pinning would have overwritten good
 * line data with a broken snapshot. Neither side is uniformly authoritative: early sessions
 * have unconverted snapshots, later ones have lines that re-derive through a repaired chain.
 * Reconciling them needs per-session judgment and is its own job. The audit below prints the
 * evidence.
 */
import { prisma } from '../src/lib/prisma'
import { countDimsOf, lineCountedBase, countUomFactor, getCountableUoms } from '../src/lib/count-uom'
import { asChainItem, pricePerBaseUnit } from '../src/lib/item-model'
import { writeFileSync } from 'fs'

const APPLY = process.argv.includes('--apply')

/**
 * Step A. One entry per line whose bad conversion is still driving a live number.
 * Matched on (item, count date, stored unit, stored qty) so it is explicit and
 * re-runnable rather than inferred, and asserted against the frozen snapshot before
 * anything is written.
 */
type LiveFix = {
  itemName: string; countDate: string; fromUom: string; qty: number
  /** the unit to store — must be one the item genuinely offers */
  unit: string
  /** the base quantity we expect to find frozen in the snapshot (the bad value) */
  expectFrozenBase: number
  why: string
}

const LIVE_FIXES: LiveFix[] = [
  { itemName: 'peaches', countDate: '2026-08-01', fromUom: 'each', qty: 25, unit: 'each',
    expectFrozenBase: 226796,
    why: '25 peaches. "each" now resolves through the item\'s own bridge (1 each = 150 g) ' +
         'instead of the 20 lb case: 3,750 g, not 226,796 g.' },
]

async function main() {
  const backup: unknown[] = []
  const lineWrites: ReturnType<typeof prisma.countLine.update>[] = []
  const snapWrites: ReturnType<typeof prisma.inventorySnapshot.updateMany>[] = []
  const itemWrites: ReturnType<typeof prisma.inventoryItem.update>[] = []
  const revaluedSessions = new Set<string>()
  let liveDelta = 0

  // ── Step A ───────────────────────────────────────────────────────────────────────
  console.log('=== A. live inflation (moves the current valuation) ===')
  const fixedLineIds = new Set<string>()
  for (const f of LIVE_FIXES) {
    const item = await prisma.inventoryItem.findFirst({ where: { itemName: f.itemName } })
    if (!item) { console.log(`  SKIP ${f.itemName} — not found`); continue }
    const dims = countDimsOf(item)

    const candidates = await prisma.countLine.findMany({
      where: {
        inventoryItemId: item.id,
        selectedUom: f.fromUom,
        session: { status: 'FINALIZED', sessionDate: new Date(`${f.countDate}T00:00:00.000Z`) },
      },
      include: { session: { select: { id: true, label: true } } },
    })
    const match = candidates.filter(l => Number(l.countedQty) === f.qty)
    if (match.length !== 1) {
      console.log(`  SKIP ${f.itemName} @ ${f.countDate} — ${match.length} lines match ${f.qty} "${f.fromUom}" ` +
                  `(already repaired, or ambiguous — refusing to guess)`)
      continue
    }
    const line = match[0]
    const snap = await prisma.inventorySnapshot.findFirst({
      where: { sessionId: line.session.id, inventoryItemId: item.id },
    })
    if (!snap) { console.log(`  SKIP ${f.itemName} — no snapshot to verify against`); continue }

    const frozenBase = Number(snap.qtyOnHand)
    if (Math.abs(frozenBase - f.expectFrozenBase) > 1e-6) {
      console.log(`  SKIP ${f.itemName} — snapshot holds ${frozenBase}, expected ${f.expectFrozenBase}. ` +
                  `The data moved since this repair was written; re-check before forcing it.`)
      continue
    }
    const factor = countUomFactor(f.unit, dims)
    if (factor === null) {
      console.log(`  SKIP ${f.itemName} — "${f.unit}" is not a valid count unit ` +
                  `(valid: ${getCountableUoms(dims).map(o => o.label).join(', ')})`)
      continue
    }

    const newBase = f.qty * factor
    const livePpb = pricePerBaseUnit(asChainItem(item as never))
    const priceAtCount = Number(line.priceAtCount)
    const expected = Number(line.expectedQty)
    // Only touch stockOnHand when this line is still what it was set from.
    const drivesStock = Math.abs(Number(item.stockOnHand) - frozenBase) < 1e-6

    console.log(
      `  FIX  ${item.itemName.padEnd(26)} ${f.countDate}  ${f.qty} "${f.fromUom}" → ${f.qty} "${f.unit}"   ` +
      `${frozenBase.toFixed(1)} → ${newBase.toFixed(1)} ${item.baseUnit}`)
    console.log(`       ${f.why}`)
    console.log(`       snapshot qty ${frozenBase} → ${newBase} (frozen value $${Number(snap.totalValue).toFixed(2)} → ` +
                `$${(newBase * Number(snap.pricePerBaseUnit)).toFixed(2)})`)
    if (drivesStock) {
      liveDelta += (frozenBase - newBase) * livePpb
      console.log(`       LIVE stockOnHand ${Number(item.stockOnHand)} → ${newBase} ` +
                  `= −$${((frozenBase - newBase) * livePpb).toFixed(2)} off the current valuation`)
    } else {
      console.log(`       stockOnHand (${Number(item.stockOnHand)}) came from a later count — not touched`)
    }

    backup.push({ step: 'A', lineId: line.id, sessionId: line.session.id, itemId: item.id, itemName: item.itemName,
      before: { countedQty: String(line.countedQty), selectedUom: line.selectedUom,
                variancePct: String(line.variancePct), varianceCost: String(line.varianceCost),
                snapshotQty: String(snap.qtyOnHand), snapshotValue: String(snap.totalValue),
                stockOnHand: String(item.stockOnHand) } })

    lineWrites.push(prisma.countLine.update({
      where: { id: line.id },
      data: {
        countedQty: f.qty, selectedUom: f.unit,
        variancePct: expected > 0 ? ((newBase - expected) / expected) * 100 : 0,
        varianceCost: (newBase - expected) * priceAtCount,
      },
    }))
    snapWrites.push(prisma.inventorySnapshot.updateMany({
      where: { sessionId: line.session.id, inventoryItemId: item.id },
      // Keep the snapshot's own frozen price — only the quantity was wrong.
      data: { qtyOnHand: newBase, totalValue: newBase * Number(snap.pricePerBaseUnit) },
    }))
    if (drivesStock) {
      // lastCountQty is left alone: it is a display-only column now, and on a multi-RC
      // item it legitimately holds whichever revenue centre counted last.
      itemWrites.push(prisma.inventoryItem.update({ where: { id: item.id }, data: { stockOnHand: newBase } }))
    }
    fixedLineIds.add(line.id)
    revaluedSessions.add(line.session.id)
  }

  // ── Audit (read-only) ────────────────────────────────────────────────────────────
  // Where a line no longer re-derives to what its own session banked. NOT repaired here —
  // see the header: the snapshot is not uniformly the better number.
  console.log('\n=== audit: lines that no longer re-derive to their own frozen snapshot (NOT repaired) ===')
  const sessions = await prisma.countSession.findMany({
    where: { status: 'FINALIZED' },
    select: { id: true, label: true, sessionDate: true, totalCountedValue: true, revenueCenter: { select: { name: true } } },
    orderBy: { sessionDate: 'asc' },
  })
  let drifted = 0
  let driftValue = 0
  for (const s of sessions) {
    const lines = await prisma.countLine.findMany({
      where: { sessionId: s.id, skipped: false, countedQty: { not: null } },
      include: { inventoryItem: true },
    })
    const snaps = await prisma.inventorySnapshot.findMany({ where: { sessionId: s.id } })
    const snapBy = new Map(snaps.map(x => [x.inventoryItemId, x]))
    let n = 0
    let v = 0
    for (const l of lines) {
      if (fixedLineIds.has(l.id)) continue
      const snap = snapBy.get(l.inventoryItemId)
      if (!snap) continue
      const frozen = Number(snap.qtyOnHand)
      const rederived = lineCountedBase(l, countDimsOf(l.inventoryItem))
      if (Math.abs(rederived - frozen) < 1e-6) continue
      n++
      v += Math.abs(rederived - frozen) * Number(snap.pricePerBaseUnit)
    }
    if (n === 0) continue
    drifted += n
    driftValue += v
    console.log(
      `  ${s.sessionDate.toISOString().slice(0, 10)} ${(s.revenueCenter?.name ?? 'NULL-RC').padEnd(9)} ` +
      `${s.label.slice(0, 24).padEnd(24)} ${String(n).padStart(3)}/${String(lines.length).padEnd(4)} lines drift, ` +
      `$${v.toFixed(2).padStart(11)}   session total $${Number(s.totalCountedValue).toFixed(2)}`)
  }
  console.log(`  ${drifted} line(s), $${driftValue.toFixed(2)} of re-derivation disagreement — needs per-session judgment.`)
  console.log('  Which side is right varies BY SESSION, so do not batch-fix: on 1 Apr all 313 snapshot rows hold the')
  console.log('  number typed with no conversion applied (a 313-line full count totalling $75.71), so there the LINE is')
  console.log('  the better record; on later sessions the snapshot is frozen and correct while the line re-derives')
  console.log('  through a pack chain that has since been repaired.')

  console.log(`\nrepaired: ${fixedLineIds.size} line(s) — $${liveDelta.toFixed(2)} removed from the current valuation`)

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply.')
    await prisma.$disconnect()
    return
  }

  const path = `count-unit-repair-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  writeFileSync(path, JSON.stringify(backup, null, 2))
  console.log(`\nbackup written: ${path}`)

  await prisma.$transaction([...lineWrites, ...snapWrites, ...itemWrites])
  console.log(`✓ ${lineWrites.length} lines, ${snapWrites.length} snapshots, ${itemWrites.length} items updated`)

  // Re-total only the sessions whose FROZEN values actually changed (step A), from their
  // snapshots, so the session headline matches the rows it is made of. Step B never
  // touches a snapshot, so those sessions' totals are already correct.
  for (const sessionId of revaluedSessions) {
    const snaps = await prisma.inventorySnapshot.findMany({ where: { sessionId }, select: { totalValue: true } })
    const total = snaps.reduce((a, x) => a + Number(x.totalValue), 0)
    const before = await prisma.countSession.findUnique({ where: { id: sessionId }, select: { label: true, totalCountedValue: true } })
    await prisma.countSession.update({ where: { id: sessionId }, data: { totalCountedValue: total } })
    console.log(`  session "${before?.label}" totalCountedValue $${Number(before?.totalCountedValue).toFixed(2)} → $${total.toFixed(2)}`)
  }
  await prisma.$disconnect()
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
