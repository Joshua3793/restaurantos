import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { convertCountQtyToBase, countEntriesToBase, type CountEntry } from '@/lib/count-uom'
import { withPpb } from '@/lib/item-model'

// PATCH /api/count/sessions/:id/lines/:lineId
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; lineId: string } }
) {
  const body = await req.json()
  const { countedQty, selectedUom, skipped, notes, expectedUpdatedAt, entries } = body

  const line = await prisma.countLine.findUnique({
    where: { id: params.lineId },
    include: { inventoryItem: true },
  })
  if (!line) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Optimistic concurrency check: client sends the line's updatedAt it last saw.
  // If the stored updatedAt differs, another device has edited this line.
  if (expectedUpdatedAt && new Date(expectedUpdatedAt).getTime() !== line.updatedAt.getTime()) {
    return NextResponse.json(
      {
        error: 'Conflict',
        message: 'This line was edited on another device. Refresh to see the latest count.',
        currentLine: line,
      },
      { status: 409 },
    )
  }

  const item = line.inventoryItem
  const itemDims = {
    dimension: item.dimension,
    baseUnit:  item.baseUnit,
    packChain: item.packChain,
    countUnit: item.countUnit,
  }

  let data: Parameters<typeof prisma.countLine.update>[0]['data'] = {}

  // entries (mixed-unit) is authoritative when present and non-empty.
  const validEntries: CountEntry[] | null =
    Array.isArray(entries) && entries.length > 0
      ? entries
          .map((e: { unit?: unknown; qty?: unknown }) => ({ unit: String(e.unit ?? ''), qty: Number(e.qty) || 0 }))
          .filter((e: CountEntry) => e.unit)
      : null

  if (skipped === true) {
    data = { skipped: true, countedQty: line.expectedQty, variancePct: 0, varianceCost: 0, entries: Prisma.DbNull }
  } else if (skipped === false) {
    data = { skipped: false, countedQty: null, variancePct: null, varianceCost: null, entries: Prisma.DbNull }
  } else if (validEntries && validEntries.length > 0) {
    // Mixed-unit count: entries are authoritative. We store the summed base as
    // countedQty with selectedUom = baseUnit so every legacy reader that does
    // convertCountQtyToBase(countedQty, selectedUom) (a base→base identity)
    // still yields the correct base, while entries remain the source of truth.
    const countedBase = countEntriesToBase(validEntries, itemDims)
    const expected    = Number(line.expectedQty)
    const price       = Number(line.priceAtCount)
    data = {
      entries:      validEntries as unknown as Prisma.InputJsonValue,
      countedQty:   countedBase,
      selectedUom:  item.baseUnit,
      skipped:      false,
      variancePct:  expected > 0 ? ((countedBase - expected) / expected) * 100 : 0,
      varianceCost: (countedBase - expected) * price,
      ...(notes !== undefined ? { notes } : {}),
    }
  } else if (countedQty !== undefined) {
    const counted   = parseFloat(String(countedQty))
    // selectedUom from body takes priority; fall back to what's already on the line
    const uom       = selectedUom ?? line.selectedUom
    // Convert entered qty to baseUnit for variance comparison (expectedQty is in baseUnit)
    const countedBase = convertCountQtyToBase(counted, uom, itemDims)
    const expected  = Number(line.expectedQty)
    const price     = Number(line.priceAtCount)
    data = {
      countedQty:   counted,
      skipped:      false,
      entries:      Prisma.DbNull,  // single-unit path clears any prior mixed-unit entries
      variancePct:  expected > 0 ? ((countedBase - expected) / expected) * 100 : 0,
      varianceCost: (countedBase - expected) * price,
      ...(selectedUom !== undefined ? { selectedUom } : {}),
      ...(notes       !== undefined ? { notes }       : {}),
    }
  } else {
    if (selectedUom !== undefined) data.selectedUom = selectedUom
    if (notes       !== undefined) data.notes       = notes
  }

  const updated = await prisma.countLine.update({
    where: { id: params.lineId },
    data,
    include: { inventoryItem: { include: { storageArea: true } } },
  })

  // Re-populate the computed pricePerBaseUnit the count page reads off the line.
  return NextResponse.json({ ...updated, inventoryItem: withPpb(updated.inventoryItem) })
}
