import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// Stage 1d (retire stale columns): `InventoryItem.purchasePrice`, `.location`,
// `.needsReview` and `InventorySupplierPrice.lastPrice` are no longer written
// or read. The numbers they held are DERIVED — `listedPrice(row)` (cost-basis)
// for an item, `offerListedPrice(offer)` (offer-price) for a box. Server routes
// may still EMIT `purchasePrice` / `lastPrice` as computed fields so client
// pages keep their shape; they must never select, write or read the columns.
const ROOT = join(__dirname, '..', '..') // src/
const SCAN = ['app', 'lib']

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

function files(): { rel: string; lines: string[] }[] {
  const out: { rel: string; lines: string[] }[] = []
  for (const base of SCAN) {
    for (const file of walk(join(ROOT, base))) {
      const rel = relative(ROOT, file).split('\\').join('/')
      if (rel.includes('__tests__/')) continue
      out.push({ rel, lines: readFileSync(file, 'utf8').split('\n') })
    }
  }
  return out
}

const SELECT_KEY = /\b(purchasePrice|lastPrice|needsReview|location)\s*:\s*true\b/
// The exact tokens the old writers used. The pricing JSON (`{ mode: 'PACK',
// purchasePrice }`) and the item FORM (`formToChain` input) keep a field of the
// same name — those are not the column, so lines shaped like them are skipped.
const OLD_WRITES = [
  'purchasePrice: newPurchasePrice', 'purchasePrice: purchasePriceFromPricing', 'purchasePrice: revert.',
  'purchasePrice: 0,', 'purchasePrice: price,', 'purchasePrice: recipe.totalCost',
  'needsReview: false', 'needsReview: true }',
  'location: form.location', 'location: addItemForm.location',
  'lastPrice: item.purchasePrice', 'lastPrice: offerLastPrice', 'lastPrice: derivedPrice',
]
const PRICING_OR_FORM_SHAPE = /\bmode:|qtyUOM|priceType|purchaseUnit:/
// Reads: server code only (`app/api`, `lib`). Client pages read the COMPUTED
// `purchasePrice` / `lastPrice` the server attaches. On the server, those names
// on an item/offer row mean the dropped column; the receivers below are the
// pricing JSON and item-form shapes that legitimately carry a same-named field.
const SERVER_ONLY = (rel: string) => rel.startsWith('app/api/') || rel.startsWith('lib/')
const JSON_OR_FORM_RECEIVER = new Set(['form', 'addItemForm', 'newData', 'pricing'])
// Short receivers are exempt only in the files where they are known to hold a
// pricing JSON / form / import-row shape, so a stray `row.purchasePrice` or
// `p.lastPrice` elsewhere still fails the gate.
const FILE_RECEIVERS: Record<string, string[]> = {
  'lib/inventory-import.ts': ['row'],
  'lib/cost-basis.ts': ['p'],
  'lib/offer-price.ts': ['p'],
  'lib/invoice/line-format.ts': ['p'],
  'lib/item-model-form.ts': ['f'],
}
const FIELD_READ = /\b(\w+)\??\.(purchasePrice|lastPrice|needsReview)\b/g
const ITEM_LOCATION_READ = /\b(item|inventoryItem|matchedItem|existing)\??\.location\b/

const isComment = (l: string) => /^\s*(\/\/|\*|\/\*)/.test(l)

function offenders(test: (rel: string, line: string) => boolean): string[] {
  const out: string[] = []
  for (const { rel, lines } of files()) {
    lines.forEach((line, i) => {
      if (isComment(line)) return
      if (test(rel, line)) out.push(`${rel}:${i + 1}: ${line.trim()}`)
    })
  }
  return out
}

function readsStaleField(rel: string, line: string): boolean {
  if (ITEM_LOCATION_READ.test(line)) return true
  for (const m of line.matchAll(FIELD_READ)) if (!JSON_OR_FORM_RECEIVER.has(m[1]) && !FILE_RECEIVERS[rel]?.includes(m[1])) return true
  return false
}

describe('stale columns stay unread', () => {
  it('no select asks for a stale column', () => {
    expect(offenders((_r, l) => SELECT_KEY.test(l))).toEqual([])
  })

  it('no writer uses the old tokens', () => {
    expect(offenders((_r, l) => !PRICING_OR_FORM_SHAPE.test(l) && OLD_WRITES.some((t) => l.includes(t)))).toEqual([])
  })

  it('no reader takes a stale column off a row', () => {
    expect(offenders((rel, l) => SERVER_ONLY(rel) && readsStaleField(rel, l))).toEqual([])
  })
})
