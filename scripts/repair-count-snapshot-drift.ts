/**
 * Reconcile the 75 finalized count lines that no longer re-derive to their own frozen
 * snapshot, then freeze EVERY finalized line's base quantity (countedQtyBase backfill)
 * so the divergence class is closed for good.
 *
 *   npx tsx scripts/repair-count-snapshot-drift.ts            # report only
 *   npx tsx scripts/repair-count-snapshot-drift.ts --apply    # write (backup first)
 *
 * WHY PER LINE, NOT PER SESSION. The 2026-08-12 audit classified every drifting line:
 *
 *  - UNCONVERTED-SNAP (44 lines): the snapshot froze the raw TYPED number with no
 *    conversion — "3 kg" of parmigiano banked as 3 g (the 1 Apr session totals $75.71
 *    for a 313-line full count). The LINE is the truthful record; the snapshot is
 *    rebuilt from today's re-derivation. Detected mechanically: frozen == typed.
 *
 *  - CHAIN-DRIFT (31 lines): frozen ≠ typed. Mostly the snapshot is right — it banked
 *    through the pack chain of its era, and the chain was repaired/resized since (the
 *    prep "batch" lines). But a sub-class froze the each→leaf INFLATION bug (0.7
 *    lemons banked as 12,700.6 each): there today's re-derivation is right. Neither
 *    side is uniformly authoritative, so every CHAIN-DRIFT line carries an explicit
 *    hand-judged verdict below, asserted against the live data before anything writes.
 *
 * PRICE REPAIR. When a snapshot's quantity is rebuilt, its frozen pricePerBaseUnit is
 * kept ONLY if it is genuinely a per-base price. Several are not: turmeric froze qty
 * 1.5 (kg typed) at $15.28 — a per-KG price against a per-G quantity — so scaling the
 * qty ×1000 at the frozen ppb would invent a $22,927 line. For each repaired line we
 * choose between `keep` (frozen ppb) and `preserve` (frozen totalValue ÷ new qty,
 * which keeps the banked $ unchanged) by whichever is closer to the item's LIVE
 * per-base price in log space. priceAtCount and the line's variance follow the choice.
 *
 * Stock: a repaired line only touches live stock when BOTH hold — its session is the
 * item's LATEST stock-writing count (latest default-RC/unscoped session for
 * stockOnHand; latest same-RC session for a StockAllocation) AND the live value still
 * equals the frozen one. The value check alone is a trap: PUFF PASTRY's Jun 1 line
 * froze 10 (the each→leaf bug) while the Aug 1 count legitimately counted 10 — same
 * number, different provenance; only the latest-count check tells them apart. In
 * practice the survivors are Red Peppers (1 Aug "1 cs" banked as 1 each: stockOnHand
 * 1 → 24) and three items never counted since 1 Apr.
 */
import { prisma } from '../src/lib/prisma'
import { countDimsOf, lineCountedBase } from '../src/lib/count-uom'
import { asChainItem, pricePerBaseUnit } from '../src/lib/item-model'
import { writeFileSync } from 'fs'

const APPLY = process.argv.includes('--apply')
const EPS = 1e-6
/** classifier output printed frozen values to 1 decimal; match within that rounding */
const MATCH_TOL = 0.11

type Verdict = 'KEEP_SNAPSHOT' | 'LINE_RIGHT'

/**
 * Hand-judged verdicts for every CHAIN-DRIFT line (frozen ≠ typed), keyed on
 * (session date, item, typed qty, stored unit, frozen base). A line that doesn't
 * match a key exactly is reported and SKIPPED — never guessed.
 *
 * KEEP_SNAPSHOT — the frozen value is a physically plausible banking through the
 *   era's chain (bags/wheels/bottles/batches whose size changed later).
 * LINE_RIGHT — the frozen value is the inflation bug (each/portion/kg mapped onto a
 *   pack level) or otherwise physically absurd; today's re-derivation is the record.
 */
const CHAIN_DRIFT_VERDICTS: {
  date: string; item: string; qty: number; uom: string; frozen: number; verdict: Verdict; why: string
}[] = [
  // ── 2026-06-01 Full Count ──────────────────────────────────────────────────────
  { date: '2026-06-01', item: 'PUFF PASTRY CROISSANT', qty: 1, uom: 'each', frozen: 10, verdict: 'LINE_RIGHT',
    why: 'each→leaf bug froze the 10-pack; typed each on a base-each item means 1' },
  { date: '2026-06-01', item: 'Havarti cheese', qty: 1, uom: 'kg', frozen: 3250, verdict: 'LINE_RIGHT',
    why: 'typed a measured kg — 1,000 g is the only coherent reading; 3,250 is the case' },
  { date: '2026-06-01', item: 'Sugar Brown', qty: 1, uom: 'each', frozen: 3500, verdict: 'KEEP_SNAPSHOT',
    why: '1 bag of 3.5 kg is the only physical reading; re-deriving gives an absurd 1 g' },
  { date: '2026-06-01', item: 'Onion Red', qty: 1, uom: 'each', frozen: 11339.8, verdict: 'KEEP_SNAPSHOT',
    why: '1 × 25 lb bag; re-deriving gives 1 g' },
  { date: '2026-06-01', item: 'Cheddar smoked', qty: 1, uom: 'case', frozen: 6800, verdict: 'KEEP_SNAPSHOT',
    why: 'era case was 6.8 kg; both plausible, snapshot is the banked record' },
  { date: '2026-06-01', item: 'Grana Padano', qty: 1, uom: 'each', frozen: 4000, verdict: 'KEEP_SNAPSHOT',
    why: '1 × 4 kg wheel; re-deriving gives 1 g' },
  { date: '2026-06-01', item: 'Liquid Egg Yolk', qty: 7, uom: 'each', frozen: 6615, verdict: 'KEEP_SNAPSHOT',
    why: '7 × 945 g cartons; re-deriving gives 7 g' },
  { date: '2026-06-01', item: 'Kosher Salt', qty: 1, uom: 'case', frozen: 16320, verdict: 'KEEP_SNAPSHOT',
    why: 'era case 16.3 kg vs today 12.2 kg — banked record wins' },
  { date: '2026-06-01', item: 'Lemon Juice', qty: 3, uom: 'each', frozen: 2838, verdict: 'KEEP_SNAPSHOT',
    why: '3 × 946 ml bottles of the era; "each" re-derives via a 3.8 L jug today' },
  { date: '2026-06-01', item: 'Vanilla extract', qty: 0.4, uom: 'each', frozen: 1600, verdict: 'KEEP_SNAPSHOT',
    why: '0.4 × 4 L jug; re-deriving gives 0.4 ml' },
  { date: '2026-06-01', item: 'Smoked Goat Cheese Cream', qty: 5, uom: 'l', frozen: 5000, verdict: 'KEEP_SNAPSHOT',
    why: '5 L at density 1 = 5,000 g, the correct era conversion; today "l" is cross-dimension and 1:1s to 5 g' },
  { date: '2026-06-01', item: 'Sourdough Bread', qty: 16, uom: 'kg', frozen: 16000, verdict: 'LINE_RIGHT',
    why: 'kg blindly ×1000 onto a base-each item froze 16,000 loaves; 16 is the sane record' },
  { date: '2026-06-01', item: 'Eggplant', qty: 1, uom: 'each', frozen: 24, verdict: 'LINE_RIGHT',
    why: 'each→leaf bug froze the 24-case; peaches precedent — typed each = single units' },
  { date: '2026-06-01', item: 'Avocado', qty: 1, uom: 'each', frozen: 70, verdict: 'LINE_RIGHT',
    why: 'each→leaf bug froze the 70-case' },
  { date: '2026-06-01', item: 'Cilantro', qty: 1, uom: 'case', frozen: 3, verdict: 'LINE_RIGHT',
    why: '3 g of cilantro is absurd for a typed case; today\'s case (1,814 g) is the record' },
  { date: '2026-06-01', item: 'Lemons', qty: 0.7, uom: 'each', frozen: 12700.6, verdict: 'LINE_RIGHT',
    why: '12,700 lemons is the each→case-grams inflation; 0.7 is what was typed' },
  { date: '2026-06-01', item: 'Lettuce Burger', qty: 1, uom: 'each', frozen: 24, verdict: 'LINE_RIGHT',
    why: 'each→leaf bug froze the 24-case' },
  { date: '2026-06-01', item: 'Red Peppers', qty: 3, uom: 'each', frozen: 14968.5, verdict: 'LINE_RIGHT',
    why: '14,968 "each" is a MASS-era case-grams figure; 3 is what was typed' },
  // ── 2026-06-13 Quick counts (two identical sessions) ──────────────────────────
  { date: '2026-06-13', item: 'Sourdough Bread', qty: 3, uom: 'batch', frozen: 108, verdict: 'KEEP_SNAPSHOT',
    why: 'era batch was 36 loaves (3 × 36 = 108); the batch was later resized to 72' },
  // ── 2026-06-15 ────────────────────────────────────────────────────────────────
  { date: '2026-06-15', item: 'Brioche Unsliced', qty: 24, uom: 'pack', frozen: 336, verdict: 'KEEP_SNAPSHOT',
    why: 'era pack was 14 (24 × 14 = 336); today\'s pack is 8' },
  // ── 2026-06-26 Prep Count ─────────────────────────────────────────────────────
  { date: '2026-06-26', item: 'Brioche French Toast Slice', qty: 15, uom: 'portion', frozen: 1260, verdict: 'LINE_RIGHT',
    why: 'portion→leaf bug froze 15 × 84-slice batches; 15 portions = 15 slices' },
  { date: '2026-06-26', item: 'Hash', qty: 3, uom: 'batch', frozen: 108862.1, verdict: 'KEEP_SNAPSHOT',
    why: 'era batch 36.29 kg (80 lb) vs 35 kg today — banked record wins' },
  // ── 2026-06-30 Full count ─────────────────────────────────────────────────────
  { date: '2026-06-30', item: 'Brioche French Toast Slice', qty: 1, uom: 'batch', frozen: 84, verdict: 'KEEP_SNAPSHOT',
    why: 'era batch yielded 84 slices; later resized to 57' },
  { date: '2026-06-30', item: 'Beef Tallow Aioli', qty: 1.2, uom: 'batch', frozen: 1200, verdict: 'KEEP_SNAPSHOT',
    why: 'era batch 1 kg vs 800 g today' },
  { date: '2026-06-30', item: 'Hash', qty: 5, uom: 'batch', frozen: 181436.8, verdict: 'KEEP_SNAPSHOT',
    why: 'era batch 36.29 kg' },
  { date: '2026-06-30', item: 'Mirin Seasoning', qty: 2, uom: 'each', frozen: 2000, verdict: 'KEEP_SNAPSHOT',
    why: '2 × 1 L bottles; re-deriving gives 2 ml' },
  { date: '2026-06-30', item: 'Lemon Juice', qty: 5, uom: 'each', frozen: 4730, verdict: 'KEEP_SNAPSHOT',
    why: '5 × 946 ml bottles of the era; "each" re-derives via a 3.8 L jug today' },
  { date: '2026-06-30', item: 'Smoked Goat Cheese Cream', qty: 3, uom: 'batch', frozen: 7500, verdict: 'KEEP_SNAPSHOT',
    why: 'era batch 2.5 kg vs 6.78 kg today' },
  // ── 2026-07-09 Prep Count ─────────────────────────────────────────────────────
  { date: '2026-07-09', item: 'Hash', qty: 2, uom: 'batch', frozen: 72574.7, verdict: 'KEEP_SNAPSHOT',
    why: 'era batch 36.29 kg' },
  { date: '2026-07-09', item: 'Smoked Goat Cheese Cream', qty: 2, uom: 'batch', frozen: 5000, verdict: 'KEEP_SNAPSHOT',
    why: 'era batch 2.5 kg' },
]

function verdictFor(date: string, item: string, qty: number, uom: string, frozen: number) {
  return CHAIN_DRIFT_VERDICTS.find(v =>
    v.date === date && v.item === item && v.uom === uom &&
    Math.abs(v.qty - qty) < EPS && Math.abs(v.frozen - frozen) < MATCH_TOL)
}

/** keep vs value-preserve: whichever ppb is closer to the live per-base price in log space. */
function choosePpb(frozenPpb: number, frozenValue: number, newQty: number, livePpb: number):
  { ppb: number; mode: 'keep' | 'preserve' } {
  const preserve = newQty > 0 ? frozenValue / newQty : 0
  if (!(frozenPpb > 0)) return { ppb: preserve, mode: 'preserve' }
  if (!(preserve > 0))  return { ppb: frozenPpb, mode: 'keep' }
  if (!(livePpb > 0))   return { ppb: preserve, mode: 'preserve' } // no anchor: keep the banked $
  const dKeep = Math.abs(Math.log(frozenPpb / livePpb))
  const dPres = Math.abs(Math.log(preserve / livePpb))
  return dKeep <= dPres ? { ppb: frozenPpb, mode: 'keep' } : { ppb: preserve, mode: 'preserve' }
}

async function main() {
  const backup: unknown[] = []
  const writes: ReturnType<typeof prisma.countLine.update | typeof prisma.inventorySnapshot.updateMany | typeof prisma.inventoryItem.update | typeof prisma.stockAllocation.updateMany>[] = []
  const revaluedSessions = new Set<string>()
  let repaired = 0
  let kept = 0
  let skipped = 0
  let liveDelta = 0

  const sessions = await prisma.countSession.findMany({
    where: { status: 'FINALIZED' },
    select: {
      id: true, label: true, sessionDate: true, revenueCenterId: true,
      revenueCenter: { select: { name: true, isDefault: true } },
    },
    orderBy: { sessionDate: 'asc' },
  })

  console.log('=== drifted lines: verdicts ===')
  for (const s of sessions) {
    const date = s.sessionDate.toISOString().slice(0, 10)
    const lines = await prisma.countLine.findMany({
      where: { sessionId: s.id, skipped: false, countedQty: { not: null } },
      include: { inventoryItem: true },
    })
    const snaps = await prisma.inventorySnapshot.findMany({ where: { sessionId: s.id } })
    const snapBy = new Map(snaps.map(x => [x.inventoryItemId, x]))

    for (const l of lines) {
      const snap = snapBy.get(l.inventoryItemId)
      if (!snap) continue
      const item = l.inventoryItem
      const frozen = Number(snap.qtyOnHand)
      const raw = Number(l.countedQty)
      // NOTE: countedQtyBase is null for all pre-backfill lines, so this is the pure
      // chain re-derivation. (The backfill below runs strictly after these repairs.)
      const rederived = lineCountedBase(l, countDimsOf(item))
      if (Math.abs(rederived - frozen) < EPS) continue

      const unconverted = Math.abs(frozen - raw) < EPS && Math.abs(rederived - raw) > EPS
      let verdict: Verdict
      let why: string
      if (unconverted) {
        verdict = 'LINE_RIGHT'
        why = `snapshot froze the typed number unconverted (${raw} "${l.selectedUom}" banked as ${frozen} ${item.baseUnit})`
      } else {
        const v = verdictFor(date, item.itemName, raw, l.selectedUom, frozen)
        if (!v) {
          skipped++
          console.log(`  SKIP  ${date} ${item.itemName} — CHAIN-DRIFT with no verdict entry ` +
                      `(typed ${raw} "${l.selectedUom}", frozen ${frozen}, rederived ${rederived.toFixed(1)}). Refusing to guess.`)
          continue
        }
        verdict = v.verdict
        why = v.why
      }

      if (verdict === 'KEEP_SNAPSHOT') {
        kept++
        console.log(`  KEEP  ${date} ${item.itemName.padEnd(28)} frozen ${frozen.toFixed(1)} ${item.baseUnit} stands ` +
                    `(line re-derives ${rederived.toFixed(1)}) — ${why}`)
        continue   // countedQtyBase backfill below pins the line to the snapshot
      }

      // LINE_RIGHT — rebuild the snapshot (and the line's locked price/variance) from
      // today's re-derivation, choosing the frozen-vs-preserved price per the header.
      const newQty = rederived
      const frozenPpb = Number(snap.pricePerBaseUnit)
      const frozenValue = Number(snap.totalValue)
      const livePpb = pricePerBaseUnit(asChainItem(item as never))
      const { ppb, mode } = choosePpb(frozenPpb, frozenValue, newQty, livePpb)
      const newValue = newQty * ppb
      const expected = Number(l.expectedQty)

      repaired++
      console.log(`  FIX   ${date} ${item.itemName.padEnd(28)} ${raw} "${l.selectedUom}"  ` +
                  `qty ${frozen.toFixed(1)} → ${newQty.toFixed(1)} ${item.baseUnit}  ` +
                  `ppb ${frozenPpb.toFixed(4)} → ${ppb.toFixed(4)} (${mode}, live ${livePpb.toFixed(4)})  ` +
                  `value $${frozenValue.toFixed(2)} → $${newValue.toFixed(2)}`)
      console.log(`        ${why}`)

      backup.push({
        step: 'drift', sessionId: s.id, lineId: l.id, itemId: item.id, itemName: item.itemName, date,
        before: {
          snapshotQty: String(snap.qtyOnHand), snapshotPpb: String(snap.pricePerBaseUnit),
          snapshotValue: String(snap.totalValue), priceAtCount: String(l.priceAtCount),
          variancePct: String(l.variancePct), varianceCost: String(l.varianceCost),
          stockOnHand: String(item.stockOnHand),
        },
      })

      writes.push(prisma.inventorySnapshot.updateMany({
        where: { sessionId: s.id, inventoryItemId: item.id },
        data: { qtyOnHand: newQty, pricePerBaseUnit: ppb, totalValue: newValue },
      }))
      writes.push(prisma.countLine.update({
        where: { id: l.id },
        data: {
          priceAtCount: ppb,
          countedQtyBase: newQty,
          variancePct: expected > 0 ? ((newQty - expected) / expected) * 100 : 0,
          varianceCost: (newQty - expected) * ppb,
        },
      }))
      revaluedSessions.add(s.id)

      // Live stock: only when this line's session IS the item's latest stock-writing
      // count AND the live value still equals the frozen one. Equality alone is a
      // coincidence trap (see header: PUFF PASTRY froze 10 on 1 Jun via the bug, and a
      // later count legitimately counted 10 — rewriting live stock from the old line
      // would clobber the newer count).
      const isRcScoped = !!s.revenueCenterId && !s.revenueCenter?.isDefault
      if (isRcScoped) {
        const latest = await prisma.countLine.findFirst({
          where: {
            inventoryItemId: item.id, skipped: false, countedQty: { not: null },
            session: { status: 'FINALIZED', revenueCenterId: s.revenueCenterId },
          },
          select: { sessionId: true },
          orderBy: [{ session: { sessionDate: 'desc' } }, { session: { finalizedAt: 'desc' } }],
        })
        const alloc = await prisma.stockAllocation.findUnique({
          where: { revenueCenterId_inventoryItemId: { revenueCenterId: s.revenueCenterId!, inventoryItemId: item.id } },
        })
        if (latest?.sessionId === s.id && alloc && Math.abs(Number(alloc.quantity) - frozen) < EPS) {
          console.log(`        LIVE ${s.revenueCenter?.name} allocation ${Number(alloc.quantity)} → ${newQty}`)
          liveDelta += (newQty - frozen) * livePpb
          writes.push(prisma.stockAllocation.updateMany({
            where: { revenueCenterId: s.revenueCenterId!, inventoryItemId: item.id },
            data: { quantity: newQty },
          }))
        }
      } else {
        // stockOnHand is written by default-RC and unscoped (null-RC) sessions.
        const latest = await prisma.countLine.findFirst({
          where: {
            inventoryItemId: item.id, skipped: false, countedQty: { not: null },
            session: {
              status: 'FINALIZED',
              OR: [{ revenueCenterId: null }, { revenueCenter: { isDefault: true } }],
            },
          },
          select: { sessionId: true },
          orderBy: [{ session: { sessionDate: 'desc' } }, { session: { finalizedAt: 'desc' } }],
        })
        if (latest?.sessionId === s.id && Math.abs(Number(item.stockOnHand) - frozen) < EPS) {
          console.log(`        LIVE stockOnHand ${Number(item.stockOnHand)} → ${newQty} ` +
                      `(${((newQty - frozen) * livePpb >= 0 ? '+' : '−')}$${Math.abs((newQty - frozen) * livePpb).toFixed(2)} on the current valuation)`)
          liveDelta += (newQty - frozen) * livePpb
          writes.push(prisma.inventoryItem.update({ where: { id: item.id }, data: { stockOnHand: newQty } }))
        }
      }
    }
  }

  console.log(`\n${repaired} line(s) repaired, ${kept} snapshot(s) kept, ${skipped} skipped; ` +
              `live valuation delta ${liveDelta >= 0 ? '+' : '−'}$${Math.abs(liveDelta).toFixed(2)}`)

  if (!APPLY) {
    // Preview the backfill size too.
    const toBackfill = await prisma.countLine.count({
      where: { countedQtyBase: null, skipped: false, countedQty: { not: null }, session: { status: 'FINALIZED' } },
    })
    console.log(`backfill would freeze countedQtyBase on up to ${toBackfill} finalized lines (from their snapshots).`)
    console.log('\nDRY RUN — nothing written. Re-run with --apply.')
    await prisma.$disconnect()
    return
  }

  const path = `count-snapshot-drift-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  writeFileSync(path, JSON.stringify(backup, null, 2))
  console.log(`backup written: ${path}`)

  await prisma.$transaction(writes as never[])
  console.log(`✓ ${writes.length} writes applied`)

  // Re-total sessions whose frozen rows changed, from their snapshots.
  for (const sessionId of revaluedSessions) {
    const snaps = await prisma.inventorySnapshot.findMany({ where: { sessionId }, select: { totalValue: true } })
    const total = snaps.reduce((a, x) => a + Number(x.totalValue), 0)
    const before = await prisma.countSession.findUnique({ where: { id: sessionId }, select: { label: true, totalCountedValue: true } })
    await prisma.countSession.update({ where: { id: sessionId }, data: { totalCountedValue: total } })
    console.log(`  session "${before?.label}" totalCountedValue $${Number(before?.totalCountedValue).toFixed(2)} → $${total.toFixed(2)}`)
  }

  // ── Backfill: pin every finalized counted line to its (now-reconciled) snapshot ──
  // After this, no chain edit can restate a finalized count: readers use the frozen
  // base, and re-derivation is only ever a diagnostic.
  let pinned = 0
  const finalized = await prisma.countSession.findMany({ where: { status: 'FINALIZED' }, select: { id: true } })
  for (const s of finalized) {
    const [lines, snaps] = await Promise.all([
      prisma.countLine.findMany({
        where: { sessionId: s.id, countedQtyBase: null, skipped: false, countedQty: { not: null } },
        select: { id: true, inventoryItemId: true },
      }),
      prisma.inventorySnapshot.findMany({
        where: { sessionId: s.id },
        select: { inventoryItemId: true, qtyOnHand: true },
      }),
    ])
    if (lines.length === 0) continue
    const snapBy = new Map(snaps.map(x => [x.inventoryItemId, Number(x.qtyOnHand)]))
    const updates = lines
      .filter(l => snapBy.has(l.inventoryItemId))
      .map(l => prisma.countLine.update({ where: { id: l.id }, data: { countedQtyBase: snapBy.get(l.inventoryItemId)! } }))
    if (updates.length) {
      await prisma.$transaction(updates)
      pinned += updates.length
    }
  }
  console.log(`✓ backfill: ${pinned} finalized lines pinned to their snapshot's base quantity`)

  await prisma.$disconnect()
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
