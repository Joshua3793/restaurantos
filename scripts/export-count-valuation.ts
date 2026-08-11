/**
 * Extract a physical-count valuation for an accountant: the QUANTITIES a count
 * recorded, valued at TODAY'S corrected prices.
 *
 * The count's own InventorySnapshot rows froze a price per item at finalize.
 * Where those prices were later found wrong (a supplier pack change that never
 * reached the item's format), the frozen valuation is wrong too — so this pairs
 * the counted quantity, which is still good, with the item's current
 * pricePerBaseUnit, and reports both so the restatement is auditable.
 *
 * Also records HOW each line got its quantity. `finalizeCountSession` values
 * lines nobody counted at their expected quantity, so a count total is a mix of
 * verified and carried-forward stock — material to anyone signing off on it.
 *
 * Run: TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register \
 *        scripts/export-count-valuation.ts <sessionId> [outFile.json]
 */
import fs from 'fs'
import path from 'path'
import { prisma } from '../src/lib/prisma'
import { asChainItem, pricePerBaseUnit, basePerUnit, type PackLink } from '../src/lib/item-model'
import { resolveCountUom } from '../src/lib/count-uom'

const SESSION = process.argv[2]
const OUT = path.resolve(process.cwd(), process.argv[3] || 'docs/audits/count-valuation.json')

async function main() {
  if (!SESSION) { console.error('Usage: export-count-valuation.ts <sessionId> [out.json]'); process.exit(1) }

  const session = await prisma.countSession.findUnique({
    where: { id: SESSION },
    include: { revenueCenter: { select: { name: true, isDefault: true } } },
  })
  if (!session) { console.error('No such count session'); process.exit(1) }

  const snaps = await prisma.inventorySnapshot.findMany({
    where: { sessionId: SESSION },
    include: {
      inventoryItem: {
        include: { storageArea: { select: { name: true } }, supplier: { select: { name: true } } },
      },
    },
  })
  const lines = await prisma.countLine.findMany({ where: { sessionId: SESSION } })
  const lineBy = new Map(lines.map((l) => [l.inventoryItemId, l]))

  const rows = snaps.map((s) => {
    const it = s.inventoryItem
    const ci = asChainItem(it)
    const line = lineBy.get(s.inventoryItemId)

    const qtyBase = Number(s.qtyOnHand)
    const priceAtCount = Number(s.pricePerBaseUnit)
    const priceNow = pricePerBaseUnit(ci)

    // How this line got its number. Explicit user actions first: a noMovement
    // line is a deliberate "same as last", an untouched line is nobody's answer.
    const basis = line?.skipped ? 'Skipped'
      : line?.noMovement ? 'Carried — no movement'
      : line?.countedQty != null ? 'Physically counted'
      : 'Not counted (expected qty used)'

    // Readable denominator: $/kg, $/L or $/each rather than $/g.
    const perFactor = ci.dimension === 'COUNT' ? 1 : 1000
    const perUnit = ci.dimension === 'MASS' ? 'kg' : ci.dimension === 'VOLUME' ? 'L' : 'each'

    // The unit the counter actually worked in, and the quantity in it.
    const countUom = line?.selectedUom || resolveCountUom(it) || ci.baseUnit
    const perCount = basePerUnit(ci, countUom) || 1

    return {
      item: it.itemName,
      category: s.category,
      storageArea: it.storageArea?.name ?? '',
      supplier: it.supplier?.name ?? '',
      basis,
      countQty: qtyBase / perCount,
      countUom,
      qtyBase,
      baseUnit: ci.baseUnit,
      perUnit,
      priceAtCountPerUnit: priceAtCount * perFactor,
      priceNowPerUnit: priceNow * perFactor,
      priceAtCountPerBase: priceAtCount,
      priceNowPerBase: priceNow,
      packChain: (ci.packChain as PackLink[]).map((l) => `${l.per} ${l.unit}`).join(' → '),
      isActive: it.isActive,
    }
  })

  rows.sort((a, b) => a.category.localeCompare(b.category) || a.item.localeCompare(b.item))

  const payload = {
    sessionId: session.id,
    label: session.label,
    sessionDate: session.sessionDate.toISOString().slice(0, 10),
    finalizedAt: session.finalizedAt?.toISOString() ?? null,
    revenueCenter: session.revenueCenter?.name ?? 'Unscoped',
    isDefaultRc: !!session.revenueCenter?.isDefault,
    storedTotal: Number(session.totalCountedValue),
    exportedAt: new Date().toISOString(),
    rows,
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2))

  const at = rows.reduce((t, r) => t + r.qtyBase * r.priceAtCountPerBase, 0)
  const now = rows.reduce((t, r) => t + r.qtyBase * r.priceNowPerBase, 0)
  console.log(`${payload.label} — ${payload.sessionDate} — ${payload.revenueCenter}`)
  console.log(`  rows                    ${rows.length}`)
  console.log(`  value at count prices   $${at.toFixed(2)}   (session stored $${payload.storedTotal.toFixed(2)})`)
  console.log(`  value at current prices $${now.toFixed(2)}`)
  console.log(`  restatement             $${(now - at).toFixed(2)}`)
  const byBasis = rows.reduce<Record<string, { n: number; v: number }>>((a, r) => {
    const e = a[r.basis] ?? { n: 0, v: 0 }
    e.n++; e.v += r.qtyBase * r.priceNowPerBase; a[r.basis] = e; return a
  }, {})
  for (const [k, v] of Object.entries(byBasis).sort((x, y) => y[1].v - x[1].v))
    console.log(`  ${k.padEnd(32)} ${String(v.n).padStart(3)} lines  $${v.v.toFixed(2)}`)
  console.log(`\nWrote ${OUT}`)
  await prisma.$disconnect()
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
