import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// POST — append messages to a conversation and update updatedAt
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const messages: { role: string; content: string }[] = await req.json()
  await prisma.chatMessage.createMany({
    data: messages.map(m => ({
      conversationId: params.id,
      role: m.role,
      content: m.content,
    })),
  })
  // Touch updatedAt
  await prisma.chatConversation.update({
    where: { id: params.id },
    data: { updatedAt: new Date() },
  })
  return NextResponse.json({ ok: true })
}
