import { NextRequest, NextResponse } from 'next/server'
import { requireSession, AuthError } from '@/lib/auth'
import { listToastItems, setItemMappings } from '@/lib/toast/item-mapping'

export const dynamic = 'force-dynamic'

/**
 * GET /api/toast/items — list ToastItemMap rows with current recipe links and a
 * fuzzy suggestion for each unmapped row. ADMIN-only.
 */
export async function GET() {
  try {
    await requireSession('ADMIN')
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
  const result = await listToastItems()
  return NextResponse.json(result)
}

/**
 * PATCH /api/toast/items — bulk set/clear recipe links.
 * Body: { mappings: [{ id, recipeId|null }] }. ADMIN-only.
 */
export async function PATCH(req: NextRequest) {
  try {
    await requireSession('ADMIN')
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  let body: { mappings?: { id: string; recipeId: string | null }[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!Array.isArray(body.mappings)) {
    return NextResponse.json({ error: 'mappings[] required' }, { status: 400 })
  }

  try {
    const updated = await setItemMappings(body.mappings)
    return NextResponse.json({ ok: true, updated })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
