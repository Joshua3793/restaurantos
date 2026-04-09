import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

const RECIPE_SELECT = {
  id: true, name: true, menuPrice: true,
  portionSize: true, portionUnit: true, yieldUnit: true, baseYieldQty: true,
  category: { select: { name: true, color: true } },
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const entry = await prisma.salesEntry.findUnique({
    where: { id: params.id },
    include: { lineItems: { include: { recipe: { select: RECIPE_SELECT } }, orderBy: { qtySold: 'desc' } } },
  })
  if (!entry) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(entry)
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  const { lineItems = [], ...rest } = body

  // Replace all line items
  await prisma.saleLineItem.deleteMany({ where: { saleId: params.id } })

  const entry = await prisma.salesEntry.update({
    where: { id: params.id },
    data: {
      date:         new Date(rest.date),
      totalRevenue: parseFloat(rest.totalRevenue) || 0,
      foodSalesPct: parseFloat(rest.foodSalesPct) || 0.7,
      covers:       rest.covers ? parseInt(rest.covers) : null,
      notes:        rest.notes || null,
      lineItems: {
        create: (lineItems as { recipeId: string; qtySold: number }[])
          .filter(li => li.recipeId && li.qtySold > 0)
          .map(li => ({ recipeId: li.recipeId, qtySold: parseInt(String(li.qtySold)) })),
      },
    },
    include: { lineItems: { include: { recipe: { select: RECIPE_SELECT } } } },
  })
  return NextResponse.json(entry)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await prisma.salesEntry.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true })
}
