import { NextRequest, NextResponse } from 'next/server'
import { requireSession, AuthError } from '@/lib/auth'
import { listMenuRoutes, setMenuRoutes } from '@/lib/toast/menu-sync'

export const dynamic = 'force-dynamic'

/**
 * GET /api/toast/menu-routing — distinct Toast menus + the app RC each routes to.
 * POST — body { mappings: [{ menu, revenueCenterId|null }] }. ADMIN-only.
 */
export async function GET() {
  try {
    await requireSession('ADMIN')
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
  return NextResponse.json(await listMenuRoutes())
}

export async function POST(req: NextRequest) {
  try {
    await requireSession('ADMIN')
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
  let body: { mappings?: { menu: string; revenueCenterId: string | null }[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!Array.isArray(body.mappings)) {
    return NextResponse.json({ error: 'mappings[] required' }, { status: 400 })
  }
  try {
    await setMenuRoutes(body.mappings)
    return NextResponse.json({ ok: true, updated: body.mappings.length })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
