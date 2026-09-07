/**
 * Convert every recipe's legacy `steps` / `stages` into the one Method (with
 * waits) — docs/superpowers/specs/2026-09-06-recipe-method-with-waits-design.md §6.
 *
 *   npx tsx scripts/migrate-recipe-method.ts            # report only
 *   npx tsx scripts/migrate-recipe-method.ts --apply    # write (backup first)
 *
 * Idempotent: only recipes whose `method` is still null are touched, and the
 * conversion is `legacyToMethod` — the same function the recipe panel and the
 * item drawer use to SHOW a legacy recipe, so nothing changes on screen when
 * the row is written; it just stops being derived on every read.
 *
 *  - stages present → one step per ACTIVE stage (the stage note, where chefs put
 *    instructions, becomes the step text's second line); each PASSIVE stage a
 *    wait on the step before it; then any free-text steps not already covered.
 *  - stages absent, steps present → untimed steps.
 *  - both absent, `notes` in the numbered-instructions shape the old drawer
 *    fallback parsed → untimed steps from that parse (notes are left as they are).
 *  - otherwise the recipe is left alone.
 *
 * SAFETY. A recipe with stages has live prep logs whose `stageIndex` points into
 * that chain. The conversion preserves ACTIVE→PASSIVE ordering one-to-one, so
 * the derived chain has the same length and kinds; the script ASSERTS that per
 * recipe and refuses to write the row on a mismatch (reported, never guessed).
 */
import { writeFileSync } from 'fs'
import { Prisma } from '@prisma/client'
import { prisma } from '../src/lib/prisma'
import { parseStages } from '../src/lib/prep-stages'
import { legacyToMethod, methodToChain, type MethodStep } from '../src/lib/recipe-method'

const APPLY = process.argv.includes('--apply')

/** The old item-drawer fallback: numbered instructions inside `notes`. */
function stepsFromNotes(notes: string | null): string[] {
  if (!notes || !notes.trim()) return []
  const body = notes.replace(/^\s*(?:#+\s*)?(?:instructions?|method|steps)\s*:?\s*/i, '')
  let parts = body.split(/(?=\d+[.)]\s)/).map(s => s.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean)
  if (parts.length <= 1) parts = body.split(/\n+/).map(s => s.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean)
  // Only trust it when it actually looked numbered — a one-line note is not a method.
  return /\d+[.)]\s/.test(body) && parts.length >= 2 ? parts : []
}

type Row = { id: string; name: string; type: string; steps: string[]; stages: unknown; notes: string | null }
type Plan = { row: Row; method: MethodStep[]; source: 'stages' | 'steps' | 'notes' }

async function main() {
  const rows: Row[] = await prisma.recipe.findMany({
    where: { method: { equals: Prisma.DbNull } },
    select: { id: true, name: true, type: true, steps: true, stages: true, notes: true },
    orderBy: { name: 'asc' },
  })

  const plans: Plan[] = []
  const mismatches: string[] = []
  let untouched = 0
  for (const row of rows) {
    const stages = parseStages(row.stages)
    let source: Plan['source'] | null = null
    let steps: string[] = row.steps ?? []
    if (stages) source = 'stages'
    else if (steps.length) source = 'steps'
    else {
      steps = stepsFromNotes(row.notes)
      if (steps.length) source = 'notes'
    }
    if (!source) { untouched++; continue }
    const method = legacyToMethod(stages, steps)
    if (!method) { untouched++; continue }
    if (stages) {
      const chain = methodToChain(method)
      const same = !!chain && chain.length === stages.length && chain.every((s, i) => s.kind === stages[i].kind)
      if (!same) {
        mismatches.push(`${row.name} (${row.id}): stages ${stages.map(s => s.kind[0]).join('')} → chain ${chain ? chain.map(s => s.kind[0]).join('') : 'null'}`)
        continue
      }
    }
    plans.push({ row, method, source })
  }

  const by = (s: Plan['source']) => plans.filter(p => p.source === s).length
  console.log(`recipes without a method: ${rows.length}`)
  console.log(`  convert from stages: ${by('stages')}   from steps: ${by('steps')}   from notes: ${by('notes')}   left alone: ${untouched}`)
  if (mismatches.length) {
    console.log(`\nREFUSED (chain would not match the live stages — fix by hand):`)
    for (const m of mismatches) console.log(`  ${m}`)
  }
  for (const p of plans) {
    const waits = p.method.filter(s => s.wait).length
    console.log(`  [${p.source}] ${p.row.name}: ${p.method.length} step${p.method.length === 1 ? '' : 's'}${waits ? `, ${waits} wait${waits === 1 ? '' : 's'}` : ''}`)
  }

  if (!APPLY) { console.log('\nDry run — pass --apply to write.'); return }
  if (!plans.length) { console.log('\nNothing to write.'); return }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `recipe-method-backup-${stamp}.json`
  writeFileSync(backup, JSON.stringify(plans.map(p => ({ id: p.row.id, name: p.row.name, steps: p.row.steps, stages: p.row.stages, notes: p.row.notes, method: p.method })), null, 2))
  console.log(`\nbackup: ${backup}`)

  let written = 0
  for (const p of plans) {
    await prisma.recipe.update({ where: { id: p.row.id }, data: { method: p.method as unknown as Prisma.InputJsonValue } })
    written++
  }
  console.log(`wrote method on ${written} recipe${written === 1 ? '' : 's'}.`)
}

main()
  .catch(e => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
