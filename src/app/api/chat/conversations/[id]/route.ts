import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// GET — fetch conversation with all messages
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const conversation = await prisma.chatConversation.findUnique({
    where: { id: params.id },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  })
  if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(conversation)
}

// DELETE — delete a conversation
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await prisma.chatConversation.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true })
}
