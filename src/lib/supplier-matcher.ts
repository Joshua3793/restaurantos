// src/lib/supplier-matcher.ts
// Supplier alias lookup: exact match first, fuzzy fallback, self-learning.

import { prisma } from '@/lib/prisma'

// ── Fuzzy helpers ──────────────────────────────────────────────────────────────

// Minimum fraction of the shorter name's tokens that must appear in the longer.
const FUZZY_THRESHOLD = 0.5

const BUSINESS_SUFFIXES =
  /\b(pty|ltd|limited|inc|incorporated|corp|corporation|co|llc|plc|group|trading|foods?|supply|supplies|wholesale|distribution|distributors?)\b/g

/**
 * Normalise a supplier name into a set of meaningful lowercase tokens.
 * Strips business suffixes, punctuation, and single-character noise.
 */
function tokenise(name: string): string[] {
  return name
    .toLowerCase()
    .replace(BUSINESS_SUFFIXES, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')   // punctuation → space
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(t => t.length >= 2)      // drop single-char abbreviation artifacts
}

/**
 * Token-coverage score: what fraction of the *shorter* token set is found
 * in the *longer* token set? Range [0, 1].
 *
 * Examples:
 *   "Metro C&C"  vs "Metro Cash & Carry" → tokens ["metro"] ⊂ ["metro","cash","carry"] → 1.0
 *   "SYSCO"      vs "Sysco Foods Inc"    → tokens ["sysco"] ⊂ ["sysco"]                → 1.0
 *   "Fresh Direct" vs "Fresh Direct Ltd" → ["fresh","direct"] ⊂ ["fresh","direct"]     → 1.0
 *   "Premium Meats" vs "Quality Produce" → 0 overlap                                   → 0.0
 */
function coverageScore(a: string, b: string): number {
  const ta = tokenise(a)
  const tb = tokenise(b)
  if (ta.length === 0 || tb.length === 0) return 0

  const [shorter, longer] =
    ta.length <= tb.length ? [ta, tb] : [tb, ta]
  const longerSet = new Set(longer)
  const matched = shorter.filter(t => longerSet.has(t)).length
  return matched / shorter.length
}

/**
 * Look up a supplier by an OCR-extracted invoice name.
 *
 * Order of preference:
 *   1. Exact alias match        (case-insensitive)
 *   2. Exact supplier name      (case-insensitive)
 *   3. Fuzzy alias match        (token coverage ≥ 50 %)
 *   4. Fuzzy supplier name      (token coverage ≥ 50 %)
 *
 * When a fuzzy match is found the OCR name is saved as a new alias so the
 * next scan of the same invoice format gets a fast exact hit.
 */
export async function matchSupplierByName(invoiceName: string | null | undefined): Promise<string | null> {
  if (!invoiceName || !invoiceName.trim()) return null

  const normalized = invoiceName.trim()

  // 1. Exact alias match
  const alias = await prisma.supplierAlias.findFirst({
    where: { name: { equals: normalized, mode: 'insensitive' } },
    select: { supplierId: true },
  })
  if (alias) return alias.supplierId

  // 2. Exact supplier name match
  const supplier = await prisma.supplier.findFirst({
    where: { name: { equals: normalized, mode: 'insensitive' } },
    select: { id: true },
  })
  if (supplier) return supplier.id

  // 3. Fuzzy alias match — load all aliases (small table, fine in-memory)
  const allAliases = await prisma.supplierAlias.findMany({
    select: { supplierId: true, name: true },
  })
  let bestId: string | null = null
  let bestScore = 0

  for (const a of allAliases) {
    const score = coverageScore(normalized, a.name)
    if (score >= FUZZY_THRESHOLD && score > bestScore) {
      bestScore = score
      bestId = a.supplierId
    }
  }
  if (bestId) {
    // Auto-learn so future exact lookups skip this work
    await learnAlias(bestId, normalized).catch(() => {})
    console.log(`[supplier-matcher] Fuzzy alias match: "${normalized}" → supplierId ${bestId} (score ${bestScore.toFixed(2)})`)
    return bestId
  }

  // 4. Fuzzy supplier name match
  const allSuppliers = await prisma.supplier.findMany({
    select: { id: true, name: true },
  })
  bestScore = 0

  for (const s of allSuppliers) {
    const score = coverageScore(normalized, s.name)
    if (score >= FUZZY_THRESHOLD && score > bestScore) {
      bestScore = score
      bestId = s.id
    }
  }
  if (bestId) {
    await learnAlias(bestId, normalized).catch(() => {})
    console.log(`[supplier-matcher] Fuzzy name match: "${normalized}" → supplierId ${bestId} (score ${bestScore.toFixed(2)})`)
    return bestId
  }

  return null
}

/**
 * Upsert (supplierId, invoiceName) into SupplierAlias.
 * No-op on blank/null name. Duplicate rows are silently ignored.
 */
export async function learnAlias(supplierId: string, invoiceName: string | null | undefined): Promise<void> {
  if (!supplierId || !supplierId.trim()) return
  if (!invoiceName || !invoiceName.trim()) return

  const normalized = invoiceName.trim()

  await prisma.supplierAlias.upsert({
    where: { supplierId_name: { supplierId, name: normalized } },
    create: { supplierId, name: normalized },
    update: {}, // already exists, no-op
  })
}
