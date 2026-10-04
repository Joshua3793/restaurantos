import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// The one-cost-function rule (spec 2026-10-03-item-backbone-design §2.1):
// routes and libs read an item's cost through `@/lib/cost-basis`, never the
// engine directly. The engine's money exports may only be imported by the
// pricing libs listed here and by tests.
const ROOT = join(__dirname, '..', '..')            // src/
const SCAN = ['app/api', 'lib']
const ALLOWED = [
  'lib/item-model.ts', 'lib/cost-basis.ts', 'lib/offer-price.ts', 'lib/primary-offer.ts',
  'lib/supplier-offers.ts', 'lib/item-model-form.ts', 'lib/inventory-import.ts',
  // A pricing rewrite (a measure change): it must hold the engine's own $/base
  // fixed across the change, so it reads the engine, not a cost basis.
  'lib/remeasure-plan.ts',
]
const ALLOWED_PREFIXES = ['lib/invoice/']
const MONEY = ['pricePerBaseUnit', 'withPpb', 'lineCost', 'stockValue']
const IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*['"](?:@\/lib\/item-model|\.\/item-model|\.\.\/item-model)['"]/g

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

describe('cost readers go through cost-basis', () => {
  it('no route or lib imports a money function from item-model', () => {
    const offenders: string[] = []
    for (const base of SCAN) {
      for (const file of walk(join(ROOT, base))) {
        const rel = relative(ROOT, file).split('\\').join('/')
        if (rel.includes('__tests__/')) continue
        if (ALLOWED.includes(rel) || ALLOWED_PREFIXES.some((p) => rel.startsWith(p))) continue
        const src = readFileSync(file, 'utf8')
        for (const m of src.matchAll(IMPORT_RE)) {
          const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, ''))
          const bad = names.filter((n) => MONEY.includes(n))
          if (bad.length) offenders.push(`${rel}: ${bad.join(', ')}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
