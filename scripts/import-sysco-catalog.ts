/**
 * Import Sysco purchase-history catalog and update matching inventory items.
 *
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' \
 *     scripts/import-sysco-catalog.ts \
 *     "/path/to/Shop_Purchase History_044_xxxxxx.csv"
 *
 * Behaviour:
 *   - Matches Sysco products to ALL inventory items by name (any current supplier)
 *   - On confirmed match, overrides supplier to Sysco
 *   - Skips non-food categories
 *   - Writes Sysco SUPC to InventoryItem.barcode for exact-match on future imports
 */

import { readFileSync } from 'fs'
import { createInterface } from 'readline'
import { PrismaClient } from '@prisma/client'
import { calcPricePerBaseUnit } from '../src/lib/utils'

const prisma = new PrismaClient()

// ──────────────────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────────────────
const CATEGORIES_TO_SKIP = new Set([
  'Healthcare & Hospitality',
  'Supplies & Equipment',
  'Paper & Disposable',
  'Chemical & Janitorial',
])

const CATEGORY_MAP: Record<string, string> = {
  'Dairy': 'DAIRY',
  'Meats': 'MEAT',
  'Poultry': 'MEAT',
  'Produce': 'PROD',
  'Frozen': 'FROZ',
  'Canned & Dry': 'DRY',
}

// Sysco Unit-code (col 10) → your packUOM
const UNIT_MAP: Record<string, string> = {
  KG: 'kg', GR: 'g', G: 'g',
  ML: 'ml', LT: 'l', L: 'l',
  EA: 'each', CT: 'each', PC: 'each', DZ: 'each', CA: 'each', RL: 'each', RO: 'each',
  LB: 'lb', OZ: 'oz',
}

const AUTO_THRESHOLD = 0.75
const REVIEW_THRESHOLD = 0.40

// Pure noise — never informative
const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'with', 'and', 'or', 'for',
  'each', 'pack', 'case', 'box', 'bag', 'jar', 'bottle', 'container',
  'pcs', 'pc', 'ea', 'ct',
])

// Abbreviation / synonym expansion (applied during tokenisation)
const SYNONYMS: Record<string, string> = {
  evoo: 'extra virgin olive oil',
  ev: 'extra virgin',
  ap: 'all purpose',
  reg: 'regular',
  unsalt: 'unsalted',
  whip: 'whipping',
  whipped: 'whipping',
  hom: 'homogenized',
  homo: 'homogenized',
  conc: 'concentrate',
  pwd: 'powder',
  pwdr: 'powder',
  bnls: 'boneless',
  sknls: 'skinless',
  shrd: 'shredded',
  grtd: 'grated',
  smkd: 'smoked',
}


// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────
interface SyscoProduct {
  supc: string
  pack: number          // Pack count (qtyPerPurchaseUnit)
  sizeRaw: string       // e.g. "454 G"
  packSize: number      // parsed numeric size
  packUOM: string       // normalised UOM
  brand: string
  desc: string          // cleaned description
  category: string
  caseDollars: number
  splitDollars: number | null
}

interface MatchCandidate {
  inventoryItemId: string
  inventoryItemName: string
  currentSupplier: string | null
  score: number
}

// ──────────────────────────────────────────────────────────────────────────
// CSV parsing
// ──────────────────────────────────────────────────────────────────────────
function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ }
        else inQ = false
      } else cur += c
    } else {
      if (c === ',') { out.push(cur); cur = '' }
      else if (c === '"') inQ = true
      else cur += c
    }
  }
  out.push(cur)
  return out
}

function cleanDesc(d: string): string {
  return d.replace(/🍁/g, '').replace(/\s+/g, ' ').trim()
}

function parsePackSize(sizeRaw: string, unitCode: string): { packSize: number; packUOM: string } | null {
  const numMatch = sizeRaw.match(/(\d*\.?\d+)/)
  if (!numMatch) return null
  const packSize = parseFloat(numMatch[1])
  if (!Number.isFinite(packSize) || packSize <= 0) return null
  const packUOM = UNIT_MAP[unitCode.toUpperCase()]
  if (!packUOM) return null
  return { packSize, packUOM }
}

function loadCsv(path: string): SyscoProduct[] {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  let currentCategory = ''
  const out: SyscoProduct[] = []

  for (const line of lines) {
    if (!line.trim()) continue
    const cols = parseCsvLine(line)
    const tag = cols[0]

    if (tag === 'C') {
      currentCategory = cols[1] ?? ''
      continue
    }
    if (tag !== 'P') continue
    if (CATEGORIES_TO_SKIP.has(currentCategory)) continue

    const supc = cols[1]?.trim()
    const pack = parseFloat(cols[7] ?? '0')
    const sizeRaw = cols[8] ?? ''
    const unitCode = cols[9] ?? ''
    const brand = cols[10] ?? ''
    const desc = cleanDesc(cols[12] ?? '')
    const caseDollars = parseFloat(cols[14] ?? '0')
    const splitDollars = cols[15] ? parseFloat(cols[15]) : NaN

    if (!supc || !desc || !Number.isFinite(caseDollars) || caseDollars <= 0) continue
    const ps = parsePackSize(sizeRaw, unitCode)
    if (!ps) continue

    out.push({
      supc,
      pack: Number.isFinite(pack) && pack > 0 ? pack : 1,
      sizeRaw,
      packSize: ps.packSize,
      packUOM: ps.packUOM,
      brand: brand.trim(),
      desc,
      category: currentCategory,
      caseDollars,
      splitDollars: Number.isFinite(splitDollars) ? splitDollars : null,
    })
  }
  return out
}

// ──────────────────────────────────────────────────────────────────────────
// Matching — multi-signal scoring
// ──────────────────────────────────────────────────────────────────────────

/** Singularize simple plurals: "eggs" → "egg", "tomatoes" → "tomato" */
function singularize(t: string): string {
  if (t.length <= 3) return t
  if (t.endsWith('ies')) return t.slice(0, -3) + 'y'
  if (t.endsWith('oes')) return t.slice(0, -2)
  if (t.endsWith('ses') || t.endsWith('xes') || t.endsWith('zes')) return t.slice(0, -2)
  if (t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1)
  return t
}

function tokenize(s: string): string[] {
  const raw = s.toLowerCase()
    .replace(/🍁/g, '')
    .replace(/[^a-z0-9%\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

  const out: string[] = []
  for (const t of raw) {
    if (STOPWORDS.has(t)) continue
    if (/^\d+%$/.test(t) || /^\d+$/.test(t)) continue   // strip bare percent / numbers
    const expanded = SYNONYMS[t] ?? t
    for (const sub of expanded.split(/\s+/)) {
      const sing = singularize(sub)
      if (sing.length >= 2 && !STOPWORDS.has(sing)) out.push(sing)
    }
  }
  return out
}

function tokenSet(s: string): Set<string> {
  return new Set(tokenize(s))
}

/** Character bigrams for typo tolerance */
function bigrams(s: string): Set<string> {
  const norm = s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const out = new Set<string>()
  for (let i = 0; i < norm.length - 1; i++) out.add(norm.slice(i, i + 2))
  return out
}

function jaccardOnSets<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  const union = a.size + b.size - inter
  return union > 0 ? inter / union : 0
}

/**
 * Combined score = max of three signals:
 *  1. coverage(user → sysco)  — how much of the user's name appears in Sysco's
 *     (handles "Cheddar smoked" ⊂ "Cheese Cheddar Smoked")
 *  2. coverage(sysco → user)  — handles "Cheese" → "Cheese"
 *  3. jaccard(bigrams)        — typo tolerance ("whiite" vs "white")
 *
 * Slight penalty when user-side has 1 token and sysco has many (avoid false
 * positives like single-word "Salt" matching everything containing "salt").
 */
function score(userName: string, syscoDesc: string): number {
  const tu = tokenSet(userName)
  const ts = tokenSet(syscoDesc)
  if (tu.size === 0 || ts.size === 0) return 0

  let inter = 0
  for (const t of tu) if (ts.has(t)) inter++

  const covU = inter / tu.size              // how much of user is in sysco
  const covS = inter / ts.size              // how much of sysco is in user
  const jacc = jaccardOnSets(tu, ts)
  const bg   = jaccardOnSets(bigrams(userName), bigrams(syscoDesc))

  // Combine: weight asymmetric coverage heavily, then jaccard, then bigrams as tiebreaker
  const tokenScore = 0.55 * covU + 0.25 * covS + 0.20 * jacc

  // Penalty when user side is a single very common token (avoid noisy hits)
  let penalty = 1
  if (tu.size === 1 && inter === 1) {
    const onlyTok = [...tu][0]
    if (onlyTok.length <= 4) penalty = 0.7
  }

  return Math.max(tokenScore * penalty, bg * 0.6)   // bigrams capped lower as a fallback
}

function bestMatch(syscoDesc: string, items: { id: string; itemName: string; supplier: { name: string } | null }[]): MatchCandidate | null {
  let best: MatchCandidate | null = null
  for (const item of items) {
    const s = score(item.itemName, syscoDesc)
    if (!best || s > best.score) {
      best = {
        inventoryItemId: item.id,
        inventoryItemName: item.itemName,
        currentSupplier: item.supplier?.name ?? null,
        score: s,
      }
    }
  }
  return best
}

// ──────────────────────────────────────────────────────────────────────────
// Interactive prompt
// ──────────────────────────────────────────────────────────────────────────
const rl = createInterface({ input: process.stdin, output: process.stdout })
function ask(q: string): Promise<string> {
  return new Promise(resolve => rl.question(q, resolve))
}

// ──────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────
async function main() {
  const csvPath = process.argv[2]
  if (!csvPath) { console.error('Usage: <script> <csv-path>'); process.exit(1) }

  console.log(`📂 Reading ${csvPath}\n`)
  const products = loadCsv(csvPath)
  console.log(`Parsed ${products.length} food products from CSV\n`)

  // Get or create Sysco supplier
  let sysco = await prisma.supplier.findFirst({ where: { name: { equals: 'Sysco', mode: 'insensitive' } } })
  if (!sysco) {
    sysco = await prisma.supplier.create({ data: { name: 'Sysco' } })
    console.log(`Created Sysco supplier (id=${sysco.id})\n`)
  } else {
    console.log(`Sysco supplier id=${sysco.id}\n`)
  }

  const items = await prisma.inventoryItem.findMany({
    select: { id: true, itemName: true, baseUnit: true, qtyUOM: true, innerQty: true, supplier: { select: { name: true } } },
  })
  console.log(`Loaded ${items.length} inventory items\n`)

  // Score every (sysco × item) above REVIEW threshold, then keep the highest
  // score per inventory item (so Sysco's 5 cream variants don't all overwrite
  // the same "Cream whipped" item — only the best one wins).
  type Pair = { p: SyscoProduct; m: MatchCandidate; baseUnit: string; qtyUOM: string; innerQty: number | null }
  const candidatesByItem = new Map<string, Pair>()
  const noMatchSet = new Set<SyscoProduct>(products)

  for (const p of products) {
    const m = bestMatch(p.desc, items)
    if (!m || m.score < REVIEW_THRESHOLD) continue
    const item = items.find(i => i.id === m.inventoryItemId)!
    const pair: Pair = {
      p, m,
      baseUnit: item.baseUnit,
      qtyUOM: item.qtyUOM ?? 'each',
      innerQty: item.innerQty ? Number(item.innerQty) : null,
    }
    const existing = candidatesByItem.get(m.inventoryItemId)
    if (!existing || pair.m.score > existing.m.score) {
      if (existing) noMatchSet.add(existing.p)   // demote the loser back to no-match list
      candidatesByItem.set(m.inventoryItemId, pair)
      noMatchSet.delete(p)
    }
  }

  const auto: Pair[] = []
  const review: Pair[] = []
  for (const pair of candidatesByItem.values()) {
    if (pair.m.score >= AUTO_THRESHOLD) auto.push(pair)
    else review.push(pair)
  }
  // Sort review by score descending so high-confidence items come first
  review.sort((a, b) => b.m.score - a.m.score)
  const noMatch = Array.from(noMatchSet)

  console.log(`📊 Match summary:`)
  console.log(`   ✅ Auto-update (≥${(AUTO_THRESHOLD*100).toFixed(0)}%):    ${auto.length}`)
  console.log(`   🔎 Need review (${(REVIEW_THRESHOLD*100).toFixed(0)}-${(AUTO_THRESHOLD*100).toFixed(0)}%):     ${review.length}`)
  console.log(`   ❌ No match (<${(REVIEW_THRESHOLD*100).toFixed(0)}%):       ${noMatch.length}\n`)

  // Show auto-matches preview
  if (auto.length > 0) {
    console.log('───── AUTO-MATCHES (first 10) ─────')
    for (const { p, m } of auto.slice(0, 10)) {
      console.log(`  ${(m.score*100).toFixed(0)}% │ ${m.inventoryItemName.padEnd(40)} ← ${p.desc}`)
    }
    if (auto.length > 10) console.log(`  ... and ${auto.length - 10} more`)
    console.log()
  }

  // Interactive review for borderline matches
  const approved = [...auto]
  if (review.length > 0) {
    console.log(`───── REVIEW (${review.length} items) ─────`)
    console.log(`Type y/n for each, or "q" to stop reviewing (already-reviewed will still apply).\n`)
    for (let i = 0; i < review.length; i++) {
      const { p, m } = review[i]
      const supTag = m.currentSupplier ? ` (curr: ${m.currentSupplier})` : ''
      console.log(`[${i+1}/${review.length}] ${(m.score*100).toFixed(0)}% match`)
      console.log(`   Yours:  ${m.inventoryItemName}${supTag}`)
      console.log(`   Sysco:  ${p.desc}  (${p.brand}, $${p.caseDollars} for ${p.pack}×${p.sizeRaw})`)
      const ans = (await ask('   Match? (y/N/q): ')).trim().toLowerCase()
      if (ans === 'q') break
      if (ans === 'y') approved.push(review[i])
      console.log()
    }
  }

  // Final confirmation
  console.log(`\n✅ ${approved.length} updates ready to apply to Supabase.`)
  const go = (await ask(`Type "yes" to apply: `)).trim().toLowerCase()
  if (go !== 'yes') {
    console.log('Aborted. No changes written.')
    rl.close(); await prisma.$disconnect(); return
  }

  // Apply
  let okCount = 0, errCount = 0
  for (const { p, m, baseUnit, qtyUOM, innerQty } of approved) {
    try {
      const ppbu = calcPricePerBaseUnit(
        p.caseDollars, p.pack, qtyUOM, innerQty, p.packSize, p.packUOM, 'CASE'
      )
      await prisma.inventoryItem.update({
        where: { id: m.inventoryItemId },
        data: {
          supplierId: sysco.id,
          purchasePrice: p.caseDollars,
          qtyPerPurchaseUnit: p.pack,
          packSize: p.packSize,
          packUOM: p.packUOM,
          barcode: p.supc,
          pricePerBaseUnit: ppbu,
          priceType: 'CASE',
        },
      })
      okCount++
    } catch (e) {
      errCount++
      console.error(`   ❌ ${m.inventoryItemName}:`, e instanceof Error ? e.message : e)
    }
  }

  // Reports
  console.log(`\n✅ Applied: ${okCount}   ❌ Errors: ${errCount}\n`)

  if (noMatch.length > 0) {
    console.log(`───── ${noMatch.length} CSV products with no inventory match ─────`)
    console.log(`(Candidates to add as new items in the app)\n`)
    for (const p of noMatch.slice(0, 30)) {
      console.log(`   [${p.category.padEnd(12)}] ${p.desc}  (${p.brand})`)
    }
    if (noMatch.length > 30) console.log(`   ... and ${noMatch.length - 30} more`)
  }

  rl.close()
  await prisma.$disconnect()
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
