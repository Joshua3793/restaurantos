import { NextRequest, NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { prisma } from '@/lib/prisma'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ImportedItem {
  rawName: string
  qtySold: number
  matchedRecipeId: string | null
  matchedRecipeName: string | null
  matchConfidence: 'exact' | 'fuzzy' | 'none'
}

export interface ImportParseResult {
  date: string           // YYYY-MM-DD start date
  endDate: string | null // null for single-day; ISO date for period files
  periodType: string     // 'day' | 'week' | 'month' | 'custom'
  totalSales: number
  foodSales: number
  items: ImportedItem[]
}

// ─── Fuzzy match helpers ──────────────────────────────────────────────────────

function normalize(s: string) {
  return s.toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Very simple word-overlap similarity 0-1 */
function similarity(a: string, b: string): number {
  const na = normalize(a).split(' ').filter(Boolean)
  const nb = normalize(b).split(' ').filter(Boolean)
  if (!na.length || !nb.length) return 0
  const setB = new Set(nb)
  const uniqueA = na.filter((v, i, arr) => arr.indexOf(v) === i)
  let overlap = 0
  for (const w of uniqueA) if (setB.has(w)) overlap++
  return overlap / Math.max(uniqueA.length, setB.size)
}

/** Find best recipe match for an Excel item name */
function matchRecipe(
  rawName: string,
  recipes: { id: string; name: string }[]
): { id: string; name: string; confidence: 'exact' | 'fuzzy' | 'none' } | null {
  const nRaw = normalize(rawName)

  // 1. Exact (case-insensitive)
  const exact = recipes.find(r => normalize(r.name) === nRaw)
  if (exact) return { id: exact.id, name: exact.name, confidence: 'exact' }

  // 2. One contains the other
  const contains = recipes.find(r => {
    const nr = normalize(r.name)
    return nr.includes(nRaw) || nRaw.includes(nr)
  })
  if (contains) return { id: contains.id, name: contains.name, confidence: 'fuzzy' }

  // 3. Word-overlap ≥ 0.5
  let best: { id: string; name: string } | null = null
  let bestScore = 0
  for (const r of recipes) {
    const score = similarity(rawName, r.name)
    if (score > bestScore) { bestScore = score; best = r }
  }
  if (best && bestScore >= 0.5) return { id: best.id, name: best.name, confidence: 'fuzzy' }

  return null
}

// ─── Extract dates from summary sheet ────────────────────────────────────────

function extractDates(wb: XLSX.WorkBook, filename: string): {
  startDate: string
  endDate: string | null
  periodType: string
} {
  // Try Summary sheet → row 0, col 0
  const summarySheet = wb.Sheets['Summary'] ?? wb.Sheets['summary']
  let title = ''
  if (summarySheet) {
    const rows = XLSX.utils.sheet_to_json<string[]>(summarySheet, { header: 1, defval: '' }) as string[][]
    title = String(rows[0]?.[0] ?? '')
  }
  if (!title) title = filename

  // Two-date pattern: ProductMix_2026-04-01_2026-04-30
  const rangeMatch = title.match(/(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})/)
  if (rangeMatch) {
    const startDate = rangeMatch[1]
    const endDate   = rangeMatch[2]
    const diffDays  = Math.round(
      (new Date(endDate).getTime() - new Date(startDate).getTime()) / 86_400_000
    )
    const periodType =
      diffDays >= 6  && diffDays <= 7  ? 'week'   :
      diffDays >= 28 && diffDays <= 31 ? 'month'  :
      'custom'
    return { startDate, endDate, periodType }
  }

  // Single-date pattern
  const singleMatch = title.match(/(\d{4}-\d{2}-\d{2})/)
  if (singleMatch) return { startDate: singleMatch[1], endDate: null, periodType: 'day' }

  // Fallback
  const fallback = new Date().toISOString().slice(0, 10)
  return { startDate: fallback, endDate: null, periodType: 'day' }
}

// ─── Parse All levels sheet ───────────────────────────────────────────────────

function parseAllLevels(wb: XLSX.WorkBook): {
  totalSales: number
  foodSales: number
  brunchItems: { name: string; qty: number }[]
} {
  // Toast exports the sheet as "All levels" (lowercase l)
  const sheetName = wb.SheetNames.find(n =>
    n.toLowerCase() === 'all levels' || n.toLowerCase() === 'all_levels'
  )
  if (!sheetName) throw new Error('No "All levels" sheet found in the uploaded file.')

  const ws = wb.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' }) as unknown[][]

  // Header row is index 0 — skip it
  // Row 1 (index 1): grand total row — Type="", Menu=""
  // Row 2 (index 2): BRUNCH summary row — Type="", Menu="BRUNCH"
  //
  // Column layout (0-based):
  //   0  = Type
  //   1  = Menu
  //   2  = Menu group
  //   4  = Item name
  //   8  = Qty sold
  //  15  = Net sales

  const COL_TYPE  = 0
  const COL_MENU  = 1
  const COL_ITEM  = 4
  const COL_QTY   = 8
  const COL_NET   = 15

  // Totals: scan summary rows (type === '') to get first two Net Sales values
  let totalSales = 0
  let foodSales  = 0
  let foundFirst = false
  let foundSecond = false

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    const type = String(row[COL_TYPE] ?? '').trim()
    const menu = String(row[COL_MENU] ?? '').trim()
    const net  = Number(row[COL_NET]  ?? 0)

    if (type === '') {
      if (!foundFirst) {
        totalSales = net
        foundFirst = true
      } else if (!foundSecond) {
        // The second summary row with a non-empty Menu name is food sales (BRUNCH)
        if (menu !== '') {
          foodSales = net
          foundSecond = true
        } else {
          // Another grand total row — keep looking
        }
      }
      if (foundFirst && foundSecond) break
    }
  }

  // BRUNCH items: type === "menuItem" && menu === "BRUNCH"
  const brunchItems: { name: string; qty: number }[] = []
  for (const row of rows) {
    const type = String(row[COL_TYPE] ?? '').trim()
    const menu = String(row[COL_MENU] ?? '').trim()
    if (type === 'menuItem' && menu.toUpperCase() === 'BRUNCH') {
      const name = String(row[COL_ITEM] ?? '').trim()
      const qty  = Math.round(Number(row[COL_QTY] ?? 0))
      if (name && qty > 0) brunchItems.push({ name, qty })
    }
  }

  return { totalSales, foodSales, brunchItems }
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const file = formData.get('file') as File | null
    if (!file) return NextResponse.json({ error: 'No file uploaded' }, { status: 400 })

    const buffer = Buffer.from(await file.arrayBuffer())
    const wb = XLSX.read(buffer, { type: 'buffer' })

    const { startDate, endDate, periodType } = extractDates(wb, file.name)
    const { totalSales, foodSales, brunchItems } = parseAllLevels(wb)

    // Load all MENU recipes for matching
    const recipes = await prisma.recipe.findMany({
      where: { type: 'MENU', isActive: true },
      select: { id: true, name: true },
    })

    // Match items
    const items: ImportedItem[] = brunchItems.map(bi => {
      const match = matchRecipe(bi.name, recipes)
      return {
        rawName: bi.name,
        qtySold: bi.qty,
        matchedRecipeId: match?.id ?? null,
        matchedRecipeName: match?.name ?? null,
        matchConfidence: match?.confidence ?? 'none',
      }
    })

    const result: ImportParseResult = { date: startDate, endDate, periodType, totalSales, foodSales, items }
    return NextResponse.json(result)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to parse file'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
