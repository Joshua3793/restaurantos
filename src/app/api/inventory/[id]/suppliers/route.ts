import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getSupplierOffers } from '@/lib/supplier-offers'
import { requireSession, AuthError } from '@/lib/auth'
import { setPrimaryOffer } from '@/lib/primary-offer'
import { propagatePrepCostChanges } from '@/lib/recipeCosts'

export const dynamic = 'force-dynamic'

// GET /api/inventory/[id]/suppliers — offers + derived history stats
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
  const offers = await getSupplierOffers(params.id)
  return NextResponse.json(offers)
}

// PATCH /api/inventory/[id]/suppliers — { offerId } → set primary (clears siblings)
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
  const body = await req.json().catch(() => ({}))
  if (!body.offerId) return NextResponse.json({ error: 'offerId required' }, { status: 400 })
  const offer = await prisma.inventorySupplierPrice.findFirst({
    where: { id: body.offerId, inventoryItemId: params.id },
    select: { id: true },
  })
  if (!offer) return NextResponse.json({ error: 'Offer not found' }, { status: 404 })
  const result = await setPrimaryOffer(params.id, body.offerId)
  // A primary switch is a spine change — propagate to dependent PREP recipes so
  // their costs (and every report/recipe/count read) reflect the new price now.
  // Matches the manual-edit path; session-scoped PriceAlerts are not created here.
  if (result.changed) await propagatePrepCostChanges([params.id])
  return NextResponse.json({ ok: true, repriced: result.changed, ppb: result.newPpb })
}
