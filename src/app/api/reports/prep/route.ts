import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// GET /api/reports/prep?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const startStr = searchParams.get('startDate')
  const endStr   = searchParams.get('endDate')

  if (!startStr || !endStr) {
    return NextResponse.json({ error: 'startDate and endDate are required' }, { status: 400 })
  }

  const start = new Date(startStr)
  start.setHours(0, 0, 0, 0)
  const end = new Date(endStr)
  end.setHours(23, 59, 59, 999)

  const logs = await prisma.prepLog.findMany({
    where: { logDate: { gte: start, lte: end } },
    include: { prepItem: { select: { name: true, category: true, unit: true } } },
    orderBy: { logDate: 'asc' },
  })

  // ── Daily summaries ───────────────────────────────────────────────────────
  const dailyMap = new Map<string, {
    date: string
    total: number; done: number; partial: number; blocked: number; skipped: number; notStarted: number
  }>()

  for (const log of logs) {
    const key = log.logDate.toISOString().slice(0, 10)
    if (!dailyMap.has(key)) {
      dailyMap.set(key, { date: key, total: 0, done: 0, partial: 0, blocked: 0, skipped: 0, notStarted: 0 })
    }
    const d = dailyMap.get(key)!
    d.total++
    if      (log.status === 'DONE')        d.done++
    else if (log.status === 'PARTIAL')     d.partial++
    else if (log.status === 'BLOCKED')     d.blocked++
    else if (log.status === 'SKIPPED')     d.skipped++
    else if (log.status === 'NOT_STARTED') d.notStarted++
  }

  const dailySummaries = Array.from(dailyMap.values()).map(d => ({
    ...d,
    completionRate: d.total > 0 ? Math.round(((d.done + d.partial) / d.total) * 100) : 0,
  }))

  // ── Top items (most frequently done) ─────────────────────────────────────
  const itemMap = new Map<string, { name: string; category: string; unit: string; doneCount: number; totalQty: number }>()
  for (const log of logs) {
    if (log.status !== 'DONE' && log.status !== 'PARTIAL') continue
    const key = log.prepItem.name
    if (!itemMap.has(key)) {
      itemMap.set(key, { name: key, category: log.prepItem.category, unit: log.prepItem.unit, doneCount: 0, totalQty: 0 })
    }
    const entry = itemMap.get(key)!
    entry.doneCount++
    if (log.actualPrepQty) entry.totalQty += Number(log.actualPrepQty)
  }
  const topItems = Array.from(itemMap.values())
    .sort((a, b) => b.doneCount - a.doneCount)
    .slice(0, 15)
    .map(i => ({ ...i, avgQty: i.doneCount > 0 ? i.totalQty / i.doneCount : 0 }))

  // ── Most blocked items ────────────────────────────────────────────────────
  const blockedMap = new Map<string, { name: string; blockedCount: number; reasons: string[] }>()
  for (const log of logs) {
    if (log.status !== 'BLOCKED') continue
    const key = log.prepItem.name
    if (!blockedMap.has(key)) blockedMap.set(key, { name: key, blockedCount: 0, reasons: [] })
    const entry = blockedMap.get(key)!
    entry.blockedCount++
    if (log.blockedReason) entry.reasons.push(log.blockedReason)
  }
  const topBlocked = Array.from(blockedMap.values())
    .sort((a, b) => b.blockedCount - a.blockedCount)
    .slice(0, 10)

  // ── Category breakdown ────────────────────────────────────────────────────
  const catMap = new Map<string, { category: string; total: number; done: number; partial: number }>()
  for (const log of logs) {
    const cat = log.prepItem.category || 'Uncategorized'
    if (!catMap.has(cat)) catMap.set(cat, { category: cat, total: 0, done: 0, partial: 0 })
    const entry = catMap.get(cat)!
    entry.total++
    if (log.status === 'DONE')    entry.done++
    if (log.status === 'PARTIAL') entry.partial++
  }
  const categoryBreakdown = Array.from(catMap.values())
    .sort((a, b) => b.total - a.total)
    .map(c => ({ ...c, completionRate: c.total > 0 ? Math.round(((c.done + c.partial) / c.total) * 100) : 0 }))

  // ── Overall totals ────────────────────────────────────────────────────────
  const totals = {
    total:          logs.length,
    done:           logs.filter(l => l.status === 'DONE').length,
    partial:        logs.filter(l => l.status === 'PARTIAL').length,
    blocked:        logs.filter(l => l.status === 'BLOCKED').length,
    skipped:        logs.filter(l => l.status === 'SKIPPED').length,
    notStarted:     logs.filter(l => l.status === 'NOT_STARTED').length,
    completionRate: logs.length > 0
      ? Math.round((logs.filter(l => l.status === 'DONE' || l.status === 'PARTIAL').length / logs.length) * 100)
      : 0,
  }

  return NextResponse.json({ dailySummaries, topItems, topBlocked, categoryBreakdown, totals })
}
