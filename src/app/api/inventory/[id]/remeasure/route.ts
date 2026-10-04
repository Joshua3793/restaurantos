import { NextRequest, NextResponse } from 'next/server'
import { requireSession, AuthError } from '@/lib/auth'
import { previewRemeasure, applyRemeasure, listRemeasures, RemeasureRefusal } from '@/lib/remeasure-exec'
import { dimensionOf, type Dimension } from '@/lib/item-model'
import { canonicalUom, UNIT_FACTORS } from '@/lib/uom'
import type { Bridge, Measure } from '@/lib/remeasure-plan'
import { refusalResponse } from '@/lib/remeasure-status'

export const dynamic = 'force-dynamic'
// One transaction that re-reads and rewrites every frozen row of the item
// (receipts, counts, snapshots, stock), then re-costs the recipes that use it.
export const maxDuration = 300

const authFail = (e: unknown) => {
  if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
  throw e
}

const BAD_FIELD = () => NextResponse.json({ error: 'Reload the item and try again.', code: 'BAD_FIELD' }, { status: 400 })

const DIMENSIONS: Dimension[] = ['MASS', 'VOLUME', 'COUNT']

/** `{ to, bridge }` off the body, or null when either is malformed. */
function parseMeasure(body: unknown): { to: Measure; bridge: Bridge } | null {
  const b = body as { to?: { dimension?: unknown; unit?: unknown }; bridge?: Record<string, unknown> } | null
  const dimension = b?.to?.dimension
  const unit = typeof b?.to?.unit === 'string' ? b.to.unit.trim() : ''
  if (typeof dimension !== 'string' || !DIMENSIONS.includes(dimension as Dimension) || !unit) return null
  if (dimension === 'COUNT') {
    if (canonicalUom(unit) !== 'each') return null
  } else if (!UNIT_FACTORS[canonicalUom(unit)] || dimensionOf(unit) !== dimension) {
    return null
  }

  const raw = b?.bridge ?? {}
  if (typeof raw !== 'object' || Array.isArray(raw)) return null
  const finite = (v: unknown): number | null | undefined => {
    if (v == null || v === '') return null
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined
  }
  const eachQty = finite(raw.eachQty)
  const densityGPerMl = finite(raw.densityGPerMl)
  if (eachQty === undefined || densityGPerMl === undefined) return null
  if (raw.eachUnit != null && typeof raw.eachUnit !== 'string') return null
  const eachUnit = typeof raw.eachUnit === 'string' && raw.eachUnit.trim() ? raw.eachUnit.trim() : null

  return { to: { dimension: dimension as Dimension, unit }, bridge: { eachQty, eachUnit, densityGPerMl } }
}

// GET /api/inventory/:id/remeasure → the measure changes that have not been undone.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession('MANAGER') } catch (e) { return authFail(e) }
  try {
    return NextResponse.json({ changes: await listRemeasures(params.id) })
  } catch (e) {
    console.error('[remeasure] list failed', e)
    return NextResponse.json({ error: 'Could not load the measure history.' }, { status: 500 })
  }
}

// POST /api/inventory/:id/remeasure
//   body { to: { dimension, unit }, bridge?: { eachQty?, eachUnit?, densityGPerMl? },
//          apply?: boolean, expectedLastUpdated?: string }
// apply false/missing → the preview (summary + k only); apply true → the change,
// in one transaction, recorded for undo.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  let user
  try { user = await requireSession('MANAGER') } catch (e) { return authFail(e) }

  const body = await req.json().catch(() => null)
  const parsed = parseMeasure(body)
  if (!parsed) return BAD_FIELD()
  const apply = body?.apply === true
  const expectedLastUpdated = typeof body?.expectedLastUpdated === 'string' ? body.expectedLastUpdated : null
  if (apply && !expectedLastUpdated) return BAD_FIELD()

  try {
    if (!apply) {
      const plan = await previewRemeasure(params.id, parsed.to, parsed.bridge)
      return NextResponse.json({ ok: true, plan: { k: plan.k, summary: plan.summary } })
    }
    const { remeasureId, plan } = await applyRemeasure({
      itemId: params.id, to: parsed.to, bridge: parsed.bridge,
      expectedLastUpdated: expectedLastUpdated!, userId: user.id,
    })
    return NextResponse.json({ ok: true, remeasureId, summary: plan.summary })
  } catch (e) {
    if (e instanceof RemeasureRefusal) return refusalResponse(e)
    console.error('[remeasure] failed', e)
    return NextResponse.json({ error: 'The measure change could not be completed. Nothing was changed.' }, { status: 500 })
  }
}
