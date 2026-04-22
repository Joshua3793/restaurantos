import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// DELETE /api/suppliers/[id]/aliases/[aliasId]
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; aliasId: string } }
) {
  await prisma.supplierAlias.delete({ where: { id: params.aliasId } })
  return NextResponse.json({ ok: true })
}
