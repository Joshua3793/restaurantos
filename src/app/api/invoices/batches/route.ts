import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function POST() {
  const batch = await prisma.invoiceBatch.create({
    data: { status: 'ANALYZING' },
  })
  return NextResponse.json(batch, { status: 201 })
}
