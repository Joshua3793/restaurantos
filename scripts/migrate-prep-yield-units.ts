/**
 * Re-express large PREP yields in kg / l instead of g / ml.
 *
 *   Shakshuka Sauce  25000 g  →  25 kg
 *   Vinegar Reduction 1250 ml →  1.25 l
 *
 * The recipe's yield unit is the display unit for the whole prep chain, so this
 * is NOT a one-column edit. Three stores are denominated in it and must scale
 * together or the magnitudes silently drift by 1000×:
 *
 *   1. Recipe.baseYieldQty        ÷1000 as yieldUnit g→kg / ml→l
 *   2. PrepItem.unit + parLevel / minThreshold / targetToday   (`resolvePrepUnit`
 *      mirrors the recipe yield unit; the pars are stored in that unit)
 *   3. PrepLog.requiredQty / actualPrepQty  — `computeScale` reads these against
 *      PrepItem.unit, and `count-expected.ts` credits theoretical stock from the
 *      result. Leaving historical logs at g-magnitude under a kg unit would credit
 *      1000× stock for every past prep event.
 *
 * The linked InventoryItem needs no quantity change (stockOnHand is in canonical
 * base units), but is re-synced so its packChain factor and countUnit follow. The
 * chain factor is invariant by construction: 25000 × 1 === 25 × 1000.
 *
 *   TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register \
 *     scripts/migrate-prep-yield-units.ts [--apply]
 */
try {
  process.loadEnvFile()
} catch (err) {
  console.error('Failed to load .env:', err instanceof Error ? err.message : String(err))
  process.exit(1)
}

import { prisma } from '../src/lib/prisma'
import { syncPrepToInventory, prepCountUnitFor } from '../src/lib/recipeCosts'
import { getUnitConv } from '../src/lib/utils'

const APPLY = process.argv.includes('--apply')

/** g → kg and ml → l once a batch reaches a whole unit of the larger measure. */
const PROMOTE: Record<string, string> = { g: 'kg', ml: 'l' }
const THRESHOLD = 1000

const scale = (v: unknown) => Number(v) / THRESHOLD
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(6))))

/**
 * What to do with one PrepItem's stored quantities. `parLevel`/`minThreshold`/
 * `targetToday` and its PrepLog rows are denominated in `PrepItem.unit` — NOT in
 * the recipe's yield unit — so the decision keys off the prep item's own unit:
 *
 *   'scale'   — it tracks the old yield unit (g/ml): divide everything by 1000.
 *   'already' — it is ALREADY on the target unit (kg/l) while the recipe yielded
 *               in g/ml. Its pars are already correct; touching them would be the
 *               1000× bug. Only the unit string needs no change either.
 *   'skip'    — anything else: leave it and surface it.
 */
function prepItemAction(prepUnit: string, oldYield: string, newYield: string): 'scale' | 'already' | 'skip' {
  if (prepUnit === oldYield) return 'scale'
  if (prepUnit === newYield) return 'already'
  return 'skip'
}

async function main() {
  const recipes = await prisma.recipe.findMany({
    where: { type: 'PREP' },
    select: {
      id: true, name: true, isActive: true, yieldUnit: true, baseYieldQty: true,
      inventoryItemId: true,
      prepItems: {
        select: {
          id: true, name: true, unit: true, parLevel: true, minThreshold: true, targetToday: true,
        },
      },
    },
    orderBy: { name: 'asc' },
  })

  const targets = recipes.filter(r =>
    PROMOTE[r.yieldUnit] !== undefined && Number(r.baseYieldQty) >= THRESHOLD)

  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — ${targets.length} of ${recipes.length} PREP recipes qualify\n`)

  const warnings: string[] = []

  for (const r of targets) {
    const to = PROMOTE[r.yieldUnit]
    const newYield = scale(r.baseYieldQty)

    // Invariant: the chain factor the spine prices off must not move.
    const beforeBase = Number(r.baseYieldQty) * (getUnitConv(r.yieldUnit) || 1)
    const afterBase = newYield * (getUnitConv(to) || 1)
    const ok = Math.abs(beforeBase - afterBase) < 1e-6

    const logs = await prisma.prepLog.count({
      where: { prepItemId: { in: r.prepItems.map(p => p.id) } },
    })

    console.log(
      `${r.name}${r.isActive ? '' : ' (inactive)'}\n` +
      `  yield     ${Number(r.baseYieldQty)} ${r.yieldUnit} → ${fmt(newYield)} ${to}` +
      `   [batch = ${fmt(beforeBase)} base ${ok ? 'unchanged ✓' : '*** DRIFTED ***'}]\n` +
      `  countUnit ${prepCountUnitFor(r.yieldUnit)} → ${prepCountUnitFor(to)}`,
    )
    if (!ok) warnings.push(`${r.name}: chain factor drifted — SKIPPED`)

    for (const p of r.prepItems) {
      const par = Number(p.parLevel), min = Number(p.minThreshold)
      const tgt = p.targetToday != null ? Number(p.targetToday) : null
      const action = prepItemAction(p.unit, r.yieldUnit, to)

      if (action === 'scale') {
        console.log(
          `  prepItem  unit ${p.unit} → ${to}` +
          `, par ${par} → ${fmt(scale(par))}` +
          `, min ${min} → ${fmt(scale(min))}` +
          (tgt != null ? `, target ${tgt} → ${fmt(scale(tgt))}` : '') +
          `, ${logs} log row(s) ÷${THRESHOLD}`,
        )
        // A par of a few grams is almost certainly a figure someone entered as
        // BATCHES into a gram field. Scaling preserves the same (wrong) physical
        // quantity — the honest move — but it stays wrong until a human fixes it.
        if (par > 0 && par < 100) {
          warnings.push(`${r.name}: par is ${par} ${p.unit} (~${fmt(par / Number(r.baseYieldQty))} of a batch) — looks like it was entered in batches. Scaled faithfully to ${fmt(scale(par))} ${to}; NEEDS A HUMAN FIX.`)
        }
      } else if (action === 'already') {
        console.log(`  prepItem  unit already ${p.unit} — par ${par} / min ${min} and ${logs} log row(s) LEFT ALONE (already in ${to})`)
        warnings.push(`${r.name}: prep item was already on '${p.unit}' while the recipe yielded '${r.yieldUnit}' — a unit/yield mismatch that syncPrepItemFromRecipe would have reset to '${r.yieldUnit}', reinterpreting par ${par} ${p.unit} as ${par} ${r.yieldUnit}. This migration resolves it.`)
      } else {
        console.log(`  prepItem  unit '${p.unit}' is neither '${r.yieldUnit}' nor '${to}' — LEFT ALONE`)
        warnings.push(`${r.name}: prep item unit '${p.unit}' unrecognised for this change — skipped, needs manual review`)
      }
    }
    console.log()
  }

  console.log(`${warnings.length} warning(s):`)
  for (const w of warnings) console.log(`  ⚠ ${w}`)

  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply.')
    return
  }

  let done = 0
  for (const r of targets) {
    const to = PROMOTE[r.yieldUnit]
    const newYield = scale(r.baseYieldQty)
    const beforeBase = Number(r.baseYieldQty) * (getUnitConv(r.yieldUnit) || 1)
    if (Math.abs(beforeBase - newYield * (getUnitConv(to) || 1)) >= 1e-6) continue

    // Only the prep items that actually track the OLD yield unit get scaled.
    const toScale = r.prepItems.filter(p => prepItemAction(p.unit, r.yieldUnit, to) === 'scale')

    await prisma.$transaction(async tx => {
      await tx.recipe.update({
        where: { id: r.id },
        data: { yieldUnit: to, baseYieldQty: newYield },
      })

      for (const p of toScale) {
        await tx.prepItem.update({
          where: { id: p.id },
          data: {
            unit: to,
            parLevel: scale(p.parLevel),
            minThreshold: scale(p.minThreshold),
            ...(p.targetToday != null ? { targetToday: scale(p.targetToday) } : {}),
          },
        })
      }

      if (toScale.length) {
        // Raw UPDATE: Prisma has no expression-based updateMany (field ÷ 1000).
        // $executeRawUnsafe with a literal, not a tagged template — the pooler is
        // in transaction mode and rejects named prepared statements.
        const ids = toScale.map(p => `'${p.id}'`).join(',')
        await tx.$executeRawUnsafe(
          `UPDATE "PrepLog" SET "requiredQty" = "requiredQty" / ${THRESHOLD}, ` +
          `"actualPrepQty" = "actualPrepQty" / ${THRESHOLD} ` +
          `WHERE "prepItemId" IN (${ids})`,
        )
      }
    })

    // Outside the transaction: re-derives cost from live ingredient prices.
    if (r.inventoryItemId) await syncPrepToInventory(r.id)
    done++
  }

  console.log(`\nUpdated ${done} recipe(s).`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
