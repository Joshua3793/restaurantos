import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { parseImportFile, validateRows } from '@/lib/inventory-import'

// Mutating/multipart route — must run live, never statically optimized.
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const file = formData.get('file')
    if (!file || typeof file === 'string') {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 })
    }

    const buffer = Buffer.from(await file.arrayBuffer())

    let rows
    try {
      rows = parseImportFile(buffer)
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'Could not read file' },
        { status: 400 },
      )
    }

    // Re-validate server-side — never trust a client-submitted "valid" list.
    const existing = await prisma.inventoryItem.findMany({ select: { itemName: true } })
    const existingNamesLower = new Set(existing.map(i => i.itemName.trim().toLowerCase()))
    const report = validateRows(rows, existingNamesLower)

    const valid = report.rows.filter(r => r.status === 'valid' && r.payload)
    if (valid.length === 0) {
      return NextResponse.json({ error: 'No valid rows to import', created: 0 }, { status: 400 })
    }

    await prisma.$transaction(
      valid.map(r => prisma.inventoryItem.create({
        data: {
          itemName: r.payload!.itemName,
          category: r.payload!.category,
          purchasePrice: r.payload!.purchasePrice,
          baseUnit: r.payload!.baseUnit,
          stockOnHand: r.payload!.stockOnHand,
          barcode: r.payload!.barcode,
          isActive: r.payload!.isActive,
          dimension: r.payload!.dimension,
          packChain: r.payload!.packChain as any,
          pricing: r.payload!.pricing as any,
          countUnit: r.payload!.countUnit,
        },
      })),
    )

    return NextResponse.json({ created: valid.length })
  } catch (err) {
    console.error('[inventory/import]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
