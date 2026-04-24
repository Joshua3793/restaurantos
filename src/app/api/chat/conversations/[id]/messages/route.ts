import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const messages: { role: string; content: string }[] = await req.json()
  await prisma.chatMessage.createMany({
    data: messages.map(m => ({ conversationId: params.id, role: m.role, content: m.content })),
  })
  await prisma.chatConversation.update({
    where: { id: params.id },
    data: { updatedAt: new Date() },
  })
  return NextResponse.json({ ok: true })
}
