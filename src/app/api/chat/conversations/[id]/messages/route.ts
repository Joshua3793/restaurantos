import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  // Verify the conversation belongs to this user before writing messages
  const conv = await prisma.chatConversation.findFirst({
    where: { id: params.id, userId: user.id },
    select: { id: true },
  })
  if (!conv) return NextResponse.json({ error: 'Not found' }, { status: 404 })

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
