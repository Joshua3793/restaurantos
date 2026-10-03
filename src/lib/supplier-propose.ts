import { prisma } from '@/lib/prisma'
import { coverageScore } from '@/lib/supplier-matcher'

/** Exact alias/name match (case-blind), else the best fuzzy ≥ 0.5 — WITHOUT learning an alias. */
export async function proposeSupplier(name: string): Promise<{ id: string; name: string; how: 'exact' | 'fuzzy'; score: number } | null> {
  const suppliers = await prisma.supplier.findMany({ select: { id: true, name: true, aliases: { select: { name: true } } } })
  const n = name.trim().toLowerCase()
  for (const s of suppliers) {
    if (s.name.toLowerCase() === n || s.aliases.some(a => a.name.toLowerCase() === n)) return { id: s.id, name: s.name, how: 'exact', score: 1 }
  }
  let best: { id: string; name: string; how: 'fuzzy'; score: number } | null = null
  for (const s of suppliers) {
    for (const cand of [s.name, ...s.aliases.map(a => a.name)]) {
      const score = coverageScore(name, cand)
      if (score >= 0.5 && (!best || score > best.score)) best = { id: s.id, name: s.name, how: 'fuzzy', score }
    }
  }
  return best
}
