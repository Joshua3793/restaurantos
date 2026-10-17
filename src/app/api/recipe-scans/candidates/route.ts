import { NextRequest, NextResponse } from 'next/server'
import { requireSession, AuthError } from '@/lib/auth'
import { loadCandidates, searchCandidates } from '@/lib/recipe-scan/context'

export const dynamic = 'force-dynamic'

// GET /api/recipe-scans/candidates?q= — what a scanned line can be linked to:
// live inventory items (not a prep recipe's own output) and active PREP
// recipes, each with how it's bought, its main supplier and how many recipes
// use it. Merged-away and inactive items are never offered.
export async function GET(req: NextRequest) {
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const q = (new URL(req.url).searchParams.get('q') ?? '').trim().slice(0, 100)
  const { candidates } = await loadCandidates()
  return NextResponse.json(searchCandidates(q, candidates), { headers: { 'Cache-Control': 'no-store' } })
}
