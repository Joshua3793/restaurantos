import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { parseImportFile, validateRows } from '@/lib/inventory-import'
import { requireSession, AuthError } from '@/lib/auth'

// Mutating/multipart route — must run live, never statically optimized.
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  // Item edits are MANAGER+ (src/lib/inventory-redact.ts canEditItems).
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

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
    if (rows.length === 0) {
      return NextResponse.json({ error: '0 rows found in the file' }, { status: 400 })
    }

    const existing = await prisma.inventoryItem.findMany({ select: { itemName: true } })
    const existingNamesLower = new Set(existing.map(i => i.itemName.trim().toLowerCase()))

    const report = validateRows(rows, existingNamesLower)
    return NextResponse.json(report)
  } catch (err) {
    console.error('[inventory/import/preview]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
