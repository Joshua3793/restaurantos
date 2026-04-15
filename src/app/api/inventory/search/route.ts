import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase().trim()
  const t = target.toLowerCase().trim()
  if (!q) return 100
  if (t === q) return 100
  if (t.includes(q)) return 90
  const qWords = q.split(/\s+/).filter(Boolean)
  const tWords = t.split(/[\s\-/]+/).filter(Boolean)
  const allMatch = qWords.every(qw => tWords.some(tw => tw.startsWith(qw) || tw.includes(qw)))
  if (allMatch) return 80
  const matched = qWords.filter(qw => tWords.some(tw => tw.startsWith(qw) || tw.includes(qw)))
  const ratio = matched.length / qWords.length
  if (ratio >= 0.5) return Math.round(40 + ratio * 40)
  return 0
}

// GET /api/inventory/search?q=flour&limit=10
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q')?.trim() ?? ''
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') ?? '10'), 50)

  const words = q.split(/\s+/).filter(w => w.length > 1)

  const items = await prisma.inventoryItem.findMany({
    where: {
      isActive: true,
      OR: q
        ? [
            { itemName:     { contains: q, mode: 'insensitive' } },
            { abbreviation: { contains: q, mode: 'insensitive' } },
            // Match any individual word too
            ...words.map(word => ({ itemName: { contains: word, mode: 'insensitive' as const } })),
          ]
        : undefined,
    },
    select: {
      id: true,
      itemName: true,
      abbreviation: true,
      purchaseUnit: true,
      purchasePrice: true,
      pricePerBaseUnit: true,
      baseUnit: true,
      category: true,
      qtyPerPurchaseUnit: true,
      packSize: true,
      packUOM: true,
    },
    orderBy: { itemName: 'asc' },
    take: Math.min(limit * 5, 100), // fetch extra for re-ranking
  })

  if (!q) return NextResponse.json(items.slice(0, limit))

  // Re-rank by fuzzy score
  const scored = items
    .map(item => ({
      ...item,
      _score: Math.max(
        fuzzyScore(q, item.itemName),
        item.abbreviation ? fuzzyScore(q, item.abbreviation) : 0
      ),
    }))
    .filter(i => i._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, limit)
    .map(({ _score, ...rest }) => rest)

  return NextResponse.json(scored)
}
