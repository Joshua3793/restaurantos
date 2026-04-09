import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const cats = await prisma.category.findMany({ orderBy: { name: 'asc' } })
  return NextResponse.json(cats)
}

export async function POST(req: NextRequest) {
  const { name } = await req.json()
  if (!name?.trim()) return NextResponse.json({ error: 'Name required' }, { status: 400 })
  try {
    const cat = await prisma.category.create({ data: { name: name.trim().toUpperCase() } })
    return NextResponse.json(cat, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'Category already exists' }, { status: 409 })
  }
}
