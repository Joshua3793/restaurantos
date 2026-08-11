/**
 * Build a point-in-time inventory valuation from one or more physical counts,
 * valued at TODAY'S corrected prices.
 *
 * A month-end is often counted across several sessions — PREPD one evening, the
 * rest the next morning. No single session holds the whole position: the items
 * counted in the OTHER session appear in it as carried-forward lines. So for
 * each item this takes its MOST RECENT PHYSICAL observation across the sessions
 * given, and records which count that came from.
 *
 * Prices come from the item now, not from the count. The count froze a price at
 * finalize, and several of those were later found wrong (a supplier pack change
 * that never reached the item's format), so the frozen valuation is wrong even
 * though the quantities are good. Both prices are reported per line so the
 * restatement is auditable.
 *
 * Run: TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register \
 *        scripts/export-count-valuation.ts <sessionId,sessionId,...> [out.json]
 */
import fs from 'fs'
import path from 'path'
import { prisma } from '../src/lib/prisma'
import { asChainItem, pricePerBaseUnit, basePerUnit, type PackLink } from '../src/lib/item-model'
import { lineCountedBase, resolveCountUom } from '../src/lib/count-uom'

const SESSIONS = (process.argv[2] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const OUT = path.resolve(process.cwd(), process.argv[3] || 'docs/audits/count-valuation.json')

async function main() {
  if (!SESSIONS.length) {
    console.error('Usage: export-count-valuation.ts <sessionId[,sessionId...]> [out.json]')
    process.exit(1)
  }

  const sessions = await prisma.countSession.findMany({
    where: { id: { in: SESSIONS } },
    include: { revenueCenter: { select: { name: true, isDefault: true } } },
    orderBy: { sessionDate: 'asc' },
  })
  if (sessions.length !== SESSIONS.length) {
    console.error(`Found ${sessions.length} of ${SESSIONS.length} sessions`); process.exit(1)
  }
  const rcNames = [...new Set(sessions.map((s) => s.revenueCenter?.name ?? 'Unscoped'))]
  if (rcNames.length > 1) {
    console.error(`Sessions span more than one revenue centre (${rcNames.join(', ')}) — refusing to merge them.`)
    process.exit(1)
  }
  const asOf = sessions[sessions.length - 1].sessionDate

  const lines = await prisma.countLine.findMany({
    where: { sessionId: { in: SESSIONS } },
    include: {
      inventoryItem: {
        include: { storageArea: { select: { name: true } }, supplier: { select: { name: true } } },
      },
    },
  })
  const snaps = await prisma.inventorySnapshot.findMany({ where: { sessionId: { in: SESSIONS } } })
  const dateOf = new Map(sessions.map((s) => [s.id, s.sessionDate]))
  const labelOf = new Map(sessions.map((s) => [s.id, s.sessionDate.toISOString().slice(0, 10)]))

  // Every item that appeared on any of these count sheets.
  const items = new Map<string, (typeof lines)[number]['inventoryItem']>()
  for (const l of lines) items.set(l.inventoryItemId, l.inventoryItem)

  const rows = [...items.values()].map((it) => {
    const ci = asChainItem(it)
    const mine = lines.filter((l) => l.inventoryItemId === it.id)
      .sort((a, b) => dateOf.get(b.sessionId)!.getTime() - dateOf.get(a.sessionId)!.getTime())

    // Prefer the most recent line somebody actually counted.
    const physical = mine.find((l) => !l.skipped && l.countedQty !== null)
    const chosen = physical ?? mine[0]

    let qtyBase: number
    let basis: string
    let countedOn: string
    if (physical) {
      // Take the quantity the count FROZE, not a recomputation of the counter's
      // entry against today's pack chain. Several chains have since been
      // repaired, and re-resolving "2 case" through a corrected chain answers a
      // different question than the one the counter answered — Mirin's 2,000 ml
      // becomes 166.7 ml purely because its case size was fixed afterwards. The
      // snapshot is the historical record of what was on the shelf; only the
      // PRICE is restated here.
      const snap = snaps.find((s) => s.inventoryItemId === it.id && s.sessionId === physical.sessionId)
      qtyBase = snap ? Number(snap.qtyOnHand) : lineCountedBase(physical, it)
      countedOn = labelOf.get(physical.sessionId)!
      basis = `Physically counted ${countedOn}`
    } else {
      // Nobody counted it in either session — fall back to what that count
      // recorded, which is the expected quantity, and say so.
      const snap = snaps.filter((s) => s.inventoryItemId === it.id)
        .sort((a, b) => dateOf.get(b.sessionId)!.getTime() - dateOf.get(a.sessionId)!.getTime())[0]
      qtyBase = snap ? Number(snap.qtyOnHand) : Number(it.stockOnHand)
      countedOn = snap ? labelOf.get(snap.sessionId)! : ''
      basis = chosen?.skipped ? `Skipped — expected qty at ${countedOn}`
        : chosen?.noMovement ? `Carried, no movement — expected qty at ${countedOn}`
        : `Not counted — expected qty at ${countedOn}`
    }

    const priceNow = pricePerBaseUnit(ci)
    const snapForPrice = snaps.filter((s) => s.inventoryItemId === it.id)
      .sort((a, b) => dateOf.get(b.sessionId)!.getTime() - dateOf.get(a.sessionId)!.getTime())[0]
    const priceAtCount = snapForPrice ? Number(snapForPrice.pricePerBaseUnit) : priceNow

    const perFactor = ci.dimension === 'COUNT' ? 1 : 1000
    const perUnit = ci.dimension === 'MASS' ? 'kg' : ci.dimension === 'VOLUME' ? 'L' : 'each'
    const countUom = chosen?.selectedUom || resolveCountUom(it) || ci.baseUnit
    const perCount = basePerUnit(ci, countUom) || 1

    return {
      item: it.itemName,
      category: it.category,
      storageArea: it.storageArea?.name ?? '',
      supplier: it.supplier?.name ?? '',
      basis,
      countedOn,
      countQty: qtyBase / perCount,
      countUom,
      qtyBase,
      baseUnit: ci.baseUnit,
      perUnit,
      priceAtCountPerBase: priceAtCount,
      priceNowPerBase: priceNow,
      priceAtCountPerUnit: priceAtCount * perFactor,
      priceNowPerUnit: priceNow * perFactor,
      packChain: (ci.packChain as PackLink[]).map((l) => `${l.per} ${l.unit}`).join(' → '),
      isActive: it.isActive,
    }
  })

  rows.sort((a, b) => a.category.localeCompare(b.category) || a.item.localeCompare(b.item))

  const payload = {
    sessionIds: SESSIONS,
    label: sessions.map((s) => `${s.label} (${s.sessionDate.toISOString().slice(0, 10)})`).join(' + '),
    sessionDate: asOf.toISOString().slice(0, 10),
    finalizedAt: sessions[sessions.length - 1].finalizedAt?.toISOString() ?? null,
    revenueCenter: rcNames[0],
    isDefaultRc: !!sessions[0].revenueCenter?.isDefault,
    storedTotal: sessions.reduce((t, s) => t + Number(s.totalCountedValue), 0),
    exportedAt: new Date().toISOString(),
    rows,
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2))

  const at = rows.reduce((t, r) => t + r.qtyBase * r.priceAtCountPerBase, 0)
  const now = rows.reduce((t, r) => t + r.qtyBase * r.priceNowPerBase, 0)
  console.log(`${payload.label}`)
  console.log(`  revenue centre          ${payload.revenueCenter}`)
  console.log(`  position as at          ${payload.sessionDate}`)
  console.log(`  items                   ${rows.length}`)
  console.log(`  value at count prices   $${at.toFixed(2)}`)
  console.log(`  value at current prices $${now.toFixed(2)}`)
  console.log(`  restatement             $${(now - at).toFixed(2)}\n`)
  const byBasis = rows.reduce<Record<string, { n: number; v: number }>>((a, r) => {
    const k = r.basis.replace(/ \d{4}-\d{2}-\d{2}$/, '').replace(/expected qty at .*/, 'expected qty')
    const e = a[k] ?? { n: 0, v: 0 }
    e.n++; e.v += r.qtyBase * r.priceNowPerBase; a[k] = e; return a
  }, {})
  for (const [k, v] of Object.entries(byBasis).sort((x, y) => y[1].v - x[1].v))
    console.log(`  ${k.padEnd(38)} ${String(v.n).padStart(3)} items  $${v.v.toFixed(2)}`)
  console.log(`\nWrote ${OUT}`)
  await prisma.$disconnect()
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
