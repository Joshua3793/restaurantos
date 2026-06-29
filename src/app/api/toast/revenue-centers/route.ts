import { NextRequest, NextResponse } from 'next/server'
import { requireSession, AuthError } from '@/lib/auth'
import {
  discoverRevenueCenters,
  listRevenueCenterMappings,
  setRevenueCenterMappings,
} from '@/lib/toast/menu-sync'

export const dynamic = 'force-dynamic'

/**
 * GET /api/toast/revenue-centers — discover distinct Toast revenue-center GUIDs
 * from recent order traffic (the config endpoint is 403) and cross-reference the
 * app's RevenueCenter rows. ADMIN-only.
 */
export async function GET(req: NextRequest) {
  try {
    await requireSession('ADMIN')
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    throw e
  }

  // Default: fast read of persisted mappings. `?discover=1` triggers a live
  // order sweep to refresh counts / pick up new GUIDs (slower).
  const discover = req.nextUrl.searchParams.get('discover') === '1'
  const days = Number(req.nextUrl.searchParams.get('days')) || 14
  try {
    const result = discover
      ? await discoverRevenueCenters(days)
      : await listRevenueCenterMappings()
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    )
  }
}

/**
 * POST /api/toast/revenue-centers — map/clear Toast RC GUIDs → an app
 * RevenueCenter OR a Location. Body:
 *   { mappings: [{ toastGuid, revenueCenterId?|null, locationId?|null }] }.
 * A GUID targets either a leaf RC or a location (or neither = cleared); both
 * non-null → 400. Many GUIDs may point at one target. ADMIN-only.
 */
export async function POST(req: NextRequest) {
  try {
    await requireSession('ADMIN')
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    throw e
  }

  let body: {
    mappings?: { toastGuid: string; revenueCenterId?: string | null; locationId?: string | null }[]
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!Array.isArray(body.mappings)) {
    return NextResponse.json({ error: 'mappings[] required' }, { status: 400 })
  }

  try {
    await setRevenueCenterMappings(body.mappings)
    return NextResponse.json({ ok: true, updated: body.mappings.length })
  } catch (e) {
    // Validation failures (both-set, unknown id, menu+location) surface as 400.
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    )
  }
}
