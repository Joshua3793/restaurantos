import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

// GET — list conversations for the current user only
export async function GET() {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const conversations = await prisma.chatConversation.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: 'desc' },
    include: { _count: { select: { messages: true } } },
    take: 50,
  })
  return NextResponse.json(conversations)
}

// POST — create a new conversation for the current user
export async function POST(req: NextRequest) {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const { title } = await req.json()
  const conversation = await prisma.chatConversation.create({
    data: {
      userId: user.id,
      title: title?.trim()?.slice(0, 80) || 'New conversation',
    },
  })
  return NextResponse.json(conversation, { status: 201 })
}
