/**
 * Repair plan for the inventory price audit.
 *
 * Classifies every active item by what evidence actually supports a fix, then
 * applies ONLY the classes where the evidence is unambiguous. Defaults to a dry
 * run; pass --apply to write. Every write is preceded by a full before-snapshot
 * so `scripts/revert-inventory-repair.ts` can put it back exactly.
 *
 *   dry run:  npx ts-node -r tsconfig-paths/register scripts/repair-inventory-formats.ts
 *   apply:    ... scripts/repair-inventory-formats.ts --apply
 *
 * Classes
 *   A COLLISION      a chain level shares the base unit's token ('each'), so
 *                    basePerUnit(item,'each') returns the pack size and every
 *                    count screen divides by it. Rename the level to a container
 *                    token. Pure format repair — ppb is untouched by construction.
 *   B ADOPT_INVOICE  the item's chain disagrees with the supplier's stated pack
 *                    AND the invoice-implied price lands in the BC band while the
 *                    current one does not. Two independent signals agree, so adopt
 *                    the supplier's format and its price together.
 *   C KEEP_ITEM      same disagreement, but the CURRENT price is the one in band —
 *                    the offer's format triple is the stale side. Cost is already
 *                    right; nothing to write.
 *   D NEEDS_INPUT    a real problem no evidence resolves: $0 prices, and drift
 *                    with no corroborating format conflict. Reported, never
 *                    guessed at.
 */
import fs from 'fs'
import path from 'path'
import { prisma } from '../src/lib/prisma'
import {
  asChainItem, pricePerBaseUnit, basePerPurchase, levelBaseUnits,
  invoicePackBaseTotal, packFormatsDisagree, eachMeasureOf, dimensionOf,
  type PackLink,
} from '../src/lib/item-model'
import { canonicalUom, CONTAINER_UNITS, UNIT_FACTORS } from '../src/lib/uom'
import { mirrorItemToPrimaryOffer } from '../src/lib/primary-offer'
import { benchmarkFor } from './market-benchmarks-bc'

const APPLY = process.argv.includes('--apply')
const OUT = path.resolve(process.cwd(), 'docs/audits')

type Klass = 'COLLISION' | 'ADOPT_INVOICE' | 'KEEP_ITEM' | 'NEEDS_INPUT'

interface Plan {
  id: string
  name: string
  category: string
  klass: Klass
  reason: string
  before: { packChain: PackLink[]; pricing: unknown; countUnit: string; ppbDisplay: string }
  after?: { packChain: PackLink[]; pricing?: unknown; countUnit?: string; ppbDisplay: string }
}

const disp = (dim: string) => (dim === 'MASS' ? { f: 1000, u: 'kg' } : dim === 'VOLUME' ? { f: 1000, u: 'L' } : { f: 1, u: 'each' })
const fmt = (ppb: number, dim: string) => { const d = disp(dim); return `$${(ppb * d.f).toFixed(2)}/${d.u}` }
const inBand = (ppb: number, dim: string, name: string) => {
  const b = benchmarkFor(name)
  if (!b) return null
  const d = disp(dim)
  if (b.unit !== d.u) return null
  const v = ppb * d.f
  return v >= b.lo && v <= b.hi
}

/**
 * How far outside its BC band a price sits, as a factor (1 = on the edge).
 *
 * Band edges are judgement, not measurement, so a price 3% below the bottom is
 * indistinguishable from one sitting on it. Requiring a real margin before the
 * band is allowed to justify rewriting an item stops a borderline call from
 * driving a 2× price change (Cheddar white sat $10.70 against an $11 floor).
 */
const outsideBy = (ppb: number, dim: string, name: string): number => {
  const b = benchmarkFor(name)
  if (!b) return 0
  const d = disp(dim)
  if (b.unit !== d.u) return 0
  const v = ppb * d.f
  if (v > b.hi) return v / b.hi
  if (v < b.lo) return b.lo / v
  return 0
}
const CONVINCING = 1.25

/**
 * Rebuild a chain so no level is named with the base unit's token.
 *
 * `levelBaseUnits()` keys levels by name, so ANY level called 'each' on an
 * 'each'-based item shadows the base unit — renaming only one of two such levels
 * leaves the collision in place (Apples: `[{each,1},{each,12}]` → `[{case,1},
 * {each,12}]` still resolves 'each' to 12). Rename every one of them, then
 * collapse redundant `per: 1` links so the result reads like a real pack.
 *
 * basePerPurchase is the product of every `per`, so neither step can move it —
 * the caller still asserts that, and that the collision is actually gone.
 */
function declashChain(chain: PackLink[], baseUnit: string, prefer?: string): PackLink[] {
  const taken = new Set(chain.map((l) => canonicalUom(l.unit)).filter((u) => u !== canonicalUom(baseUnit)))
  // Ordered so the outer level takes 'case' and an inner level falls to 'pack'
  // — "5 packs per case" reads true; "5 boxes per case" does not.
  //
  // `prefer` lets an orphaned countUnit name the level it was always meant to
  // point at: an item counted in 'pack' whose chain reads [{case,4},{each,6}]
  // becomes [{case,4},{pack,6}], which kills the 'each' shadow AND makes the
  // stored countUnit resolve — one move, two defects.
  const preferred = prefer && CONTAINER_UNITS.has(canonicalUom(prefer)) && !taken.has(canonicalUom(prefer))
    ? [canonicalUom(prefer)]
    : []
  const pool = [...preferred, 'case', 'pack', 'tray', 'sleeve', 'box', 'carton', 'bag']
  let next = chain.map((l) => {
    if (canonicalUom(l.unit) !== canonicalUom(baseUnit)) return { ...l }
    const name = pool.find((c) => !taken.has(c)) ?? [...CONTAINER_UNITS].find((c) => !taken.has(c)) ?? 'pack'
    taken.add(name)
    return { ...l, unit: name }
  })
  // `1 case = 1 pack, 1 pack = 12` is just `1 case = 12`. Keep the OUTER name —
  // it is what the purchase is called — and fold the inner level's content in.
  while (next.length > 1 && Number(next[0].per) === 1) {
    next = [{ unit: next[0].unit, per: Number(next[1].per) }, ...next.slice(2)]
  }
  return next
}

async function main() {
  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true },
    include: { supplierPrices: { where: { isPrimary: true } }, recipe: { select: { type: true } } },
    orderBy: { itemName: 'asc' },
  })

  const plans: Plan[] = []

  for (const it of items) {
    const ci = asChainItem(it)
    const chain = (ci.packChain ?? []) as PackLink[]
    const ppb = pricePerBaseUnit(ci)
    const before = {
      packChain: chain,
      pricing: ci.pricing,
      countUnit: ci.countUnit ?? 'each',
      ppbDisplay: fmt(ppb, ci.dimension),
    }
    const isPrep = it.recipe?.type === 'PREP'

    // ── A. count-unit collision ──────────────────────────────────────────────
    // A level whose token equals the base unit shadows it in levelBaseUnits().
    // Renaming the level cannot change basePerPurchase, so ppb is invariant.
    const lv = levelBaseUnits(chain)
    const cu = ci.countUnit ?? 'each'
    if (cu === ci.baseUnit && cu in lv && Math.abs(lv[cu] - 1) > 1e-9) {
      const next = declashChain(chain, ci.baseUnit)
      const afterCi = { ...ci, packChain: next }
      const afterPpb = pricePerBaseUnit(afterCi)
      const afterLv = levelBaseUnits(next)
      // Three post-conditions, all of which must hold or we do not write:
      // the price cannot move, the pack total cannot move, and the collision
      // must actually be gone (the base unit no longer names any level).
      const priceHeld = Math.abs(afterPpb - ppb) <= 1e-9
      const totalHeld = Math.abs(basePerPurchase(next) - basePerPurchase(chain)) <= 1e-9
      const resolved = !(ci.baseUnit in afterLv)
      if (!priceHeld || !totalHeld || !resolved) {
        plans.push({ id: it.id, name: it.itemName, category: it.category, klass: 'NEEDS_INPUT',
          reason: `cannot repair the collision safely (price held ${priceHeld}, pack total held ${totalHeld}, ` +
            `collision resolved ${resolved}) — chain ${JSON.stringify(chain)}`, before })
        continue
      }
      plans.push({
        id: it.id, name: it.itemName, category: it.category, klass: 'COLLISION',
        reason: `counting in '${cu}' resolves to ${lv[cu]} ${ci.baseUnit} instead of 1`,
        before,
        after: { packChain: next, ppbDisplay: fmt(afterPpb, ci.dimension) },
      })
      continue
    }

    // ── E. countUnit names a level the chain does not have ───────────────────
    // `resolveCountUom` falls back to the leaf when the stored countUnit does not
    // resolve, so the count screen already behaves as if it were the leaf — the
    // stored value is just a lie about it. Point it at a real level. ppb never
    // reads countUnit, so this cannot move a price.
    // Match the detector exactly: a countUnit is an orphan when it names no chain
    // level AND carries no fixed factor in the item's own dimension. `dimensionOf`
    // is the wrong test here — it maps every container token to COUNT, so 'pack'
    // on a COUNT item looks valid to it and the repair silently skipped all seven.
    const cuFactor = UNIT_FACTORS[canonicalUom(ci.countUnit ?? '')]
    const baseFactor = UNIT_FACTORS[canonicalUom(ci.baseUnit)]
    if (ci.countUnit && !(ci.countUnit in lv) && (!cuFactor || !baseFactor || cuFactor.dim !== baseFactor.dim)) {
      // Rebuild the chain naming the shadowing level after the orphaned unit, so
      // the stored countUnit becomes real instead of being redirected elsewhere.
      // Pointing it at the leaf would be worse: on [{case,4},{each,6}] the leaf
      // IS the shadow, so 'each' would count 6 buns as one.
      const next = declashChain(chain, ci.baseUnit, ci.countUnit)
      const nextLv = levelBaseUnits(next)
      const afterPpb = pricePerBaseUnit({ ...ci, packChain: next })
      const target = ci.countUnit in nextLv ? ci.countUnit
        : (next[next.length - 1]?.unit ?? ci.baseUnit)
      const totalHeld = Math.abs(basePerPurchase(next) - basePerPurchase(chain)) <= 1e-9
      const resolves = target in nextLv || Math.abs((nextLv[target] ?? 1) - 1) <= 1e-9
      if (Math.abs(afterPpb - ppb) > 1e-9 || !totalHeld || !resolves) {
        plans.push({ id: it.id, name: it.itemName, category: it.category, klass: 'NEEDS_INPUT',
          reason: `countUnit '${ci.countUnit}' names no level and cannot be repaired safely — chain ${JSON.stringify(chain)}`, before })
        continue
      }
      plans.push({
        id: it.id, name: it.itemName, category: it.category, klass: 'COLLISION',
        reason: `countUnit '${ci.countUnit}' is not a level of this chain (levels: ${Object.keys(lv).join(', ') || 'none'}) — ` +
          `rename the shadowing level '${ci.countUnit}' so counting resolves to ${nextLv[target] ?? 1} ${ci.baseUnit}`,
        before,
        after: { packChain: next, countUnit: target, ppbDisplay: fmt(afterPpb, ci.dimension) },
      })
      continue
    }

    // ── F. a level's measurement name contradicts its own quantity ───────────
    // "1 lb = 4535.92 g" is ten pounds. The QUANTITY is what costing uses and is
    // right; only the label lies. Rename it to a container token so the chain
    // stops asserting something false — basePerPurchase, and therefore ppb, is
    // untouched.
    const badLabel = chain.findIndex((l) => {
      if (l.unit === ci.baseUnit || l.unit === 'batch') return false
      const f = UNIT_FACTORS[canonicalUom(l.unit)]
      const bf = UNIT_FACTORS[canonicalUom(ci.baseUnit)]
      if (!f || !bf || f.dim !== bf.dim) return false
      const expected = f.toBase / bf.toBase
      return expected > 0 && Math.abs(Number(l.per) - expected) / expected > 0.02
    })
    if (badLabel >= 0) {
      const taken = new Set(chain.map((l) => canonicalUom(l.unit)))
      const name = ['case', 'box', 'pack', 'tray', 'bag'].find((c) => !taken.has(c)) ?? 'case'
      const next = chain.map((l, i) => (i === badLabel ? { ...l, unit: name } : { ...l }))
      const afterPpb = pricePerBaseUnit({ ...ci, packChain: next })
      if (Math.abs(afterPpb - ppb) <= 1e-9) {
        plans.push({
          id: it.id, name: it.itemName, category: it.category, klass: 'COLLISION',
          reason: `chain claims 1 ${chain[badLabel].unit} = ${chain[badLabel].per} ${ci.baseUnit}, which that unit is not — ` +
            `the quantity is right, so relabel the level '${name}'`,
          before,
          after: { packChain: next, ppbDisplay: fmt(afterPpb, ci.dimension) },
        })
        continue
      }
    }

    if (isPrep) continue // cost comes from the recipe; no supplier format to reconcile

    // ── B/C. chain vs the supplier's stated pack ─────────────────────────────
    const offer = it.supplierPrices[0]
    if (offer && offer.packQty != null && offer.packSize != null && offer.packUOM && !eachMeasureOf(it)) {
      const invTotal = invoicePackBaseTotal(
        { packQty: Number(offer.packQty), packSize: Number(offer.packSize), packUOM: offer.packUOM },
        ci.baseUnit,
      )
      const itemTotal = basePerPurchase(chain)
      const g = packFormatsDisagree(invTotal, itemTotal)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mode = (ci.pricing as any)?.mode ?? 'PACK'
      if (g.disagree && mode === 'PACK' && invTotal > 0) {
        const invoicePpb = Number(offer.lastPrice) / invTotal
        const curIn = inBand(ppb, ci.dimension, it.itemName)
        const invIn = inBand(invoicePpb, ci.dimension, it.itemName)

        if (invIn === true && curIn === false && outsideBy(ppb, ci.dimension, it.itemName) >= CONVINCING) {
          // Adopt the supplier's format AND their price — one coherent fact.
          const top = chain[0]?.unit ?? 'case'
          const next: PackLink[] = [{ unit: top, per: invTotal }]
          plans.push({
            id: it.id, name: it.itemName, category: it.category, klass: 'ADOPT_INVOICE',
            reason: `supplier pack ${offer.packQty} × ${offer.packSize} ${offer.packUOM} = ${invTotal} ${ci.baseUnit}; ` +
              `current ${fmt(ppb, ci.dimension)} is outside the BC band, supplier-implied ${fmt(invoicePpb, ci.dimension)} is inside`,
            before,
            after: {
              packChain: next,
              pricing: { mode: 'PACK', purchasePrice: Number(offer.lastPrice) },
              countUnit: top,
              ppbDisplay: fmt(invoicePpb, ci.dimension),
            },
          })
          continue
        }
        plans.push({
          id: it.id, name: it.itemName, category: it.category,
          klass: curIn === true ? 'KEEP_ITEM' : 'NEEDS_INPUT',
          reason: curIn === true
            ? `format triple is the stale side (current ${fmt(ppb, ci.dimension)} is in band) — cost already correct`
            : `chain ${itemTotal} vs supplier ${invTotal} ${ci.baseUnit} (${g.ratio.toFixed(2)}×), and neither price lands in the BC band — needs the real pack`,
          before,
        })
        continue
      }
    }

    // ── D. problems no evidence resolves ─────────────────────────────────────
    if (ppb <= 0 && it.isStocked) {
      plans.push({ id: it.id, name: it.itemName, category: it.category, klass: 'NEEDS_INPUT',
        reason: 'priced at $0 — no supplier offer carries a usable price', before })
      continue
    }
    const band = inBand(ppb, ci.dimension, it.itemName)
    if (band === false) {
      const b = benchmarkFor(it.itemName)!
      const d = disp(ci.dimension)
      plans.push({ id: it.id, name: it.itemName, category: it.category, klass: 'NEEDS_INPUT',
        reason: `${fmt(ppb, ci.dimension)} is outside the BC band ($${b.lo}–$${b.hi}/${d.u}) with no format conflict to explain it — ` +
          `either the price is genuinely this, or the pack format is wrong in a way the supplier record does not show`,
        before })
    }
  }

  // ── report ────────────────────────────────────────────────────────────────
  const by = (k: Klass) => plans.filter((p) => p.klass === k)
  console.log(APPLY ? '── APPLYING ──\n' : '── DRY RUN (pass --apply to write) ──\n')
  for (const k of ['COLLISION', 'ADOPT_INVOICE', 'KEEP_ITEM', 'NEEDS_INPUT'] as Klass[]) {
    const g = by(k)
    console.log(`${k.padEnd(14)} ${String(g.length).padStart(3)} items`)
  }
  console.log()
  for (const k of ['COLLISION', 'ADOPT_INVOICE'] as Klass[]) {
    const g = by(k)
    if (!g.length) continue
    console.log(`\n══ ${k} — will be written ══`)
    for (const p of g) {
      console.log(`  ${p.name}`)
      console.log(`     ${p.reason}`)
      console.log(`     chain ${JSON.stringify(p.before.packChain)} → ${JSON.stringify(p.after!.packChain)}`)
      console.log(`     price ${p.before.ppbDisplay} → ${p.after!.ppbDisplay}`)
    }
  }
  console.log(`\n══ NEEDS_INPUT — ${by('NEEDS_INPUT').length} items, NOT written ══`)
  for (const p of by('NEEDS_INPUT')) console.log(`  ${p.name.padEnd(38)} ${p.reason}`)

  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'repair-plan.json'), JSON.stringify(plans, null, 2))

  if (!APPLY) { await prisma.$disconnect(); return }

  // ── apply ─────────────────────────────────────────────────────────────────
  const writes = plans.filter((p) => p.after)
  const backup = writes.map((p) => ({ id: p.id, name: p.name, ...p.before }))
  const backupPath = path.join(OUT, `repair-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2))
  console.log(`\nBackup of ${backup.length} items → ${backupPath}`)

  let done = 0
  for (const p of writes) {
    await prisma.inventoryItem.update({
      where: { id: p.id },
      data: {
        packChain: p.after!.packChain as unknown as object,
        ...(p.after!.pricing ? { pricing: p.after!.pricing as object } : {}),
        ...(p.after!.countUnit ? { countUnit: p.after!.countUnit } : {}),
        lastUpdated: new Date(),
      },
    })
    // The item's chain and its PRIMARY offer's chain must stay equal — that
    // invariant holds for every item today (197/197) and writing one side alone
    // would be the first break. Same call the inventory edit route makes.
    await mirrorItemToPrimaryOffer(p.id)
    done++
  }
  console.log(`Updated ${done} items (primary offers mirrored).`)
  await prisma.$disconnect()
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
