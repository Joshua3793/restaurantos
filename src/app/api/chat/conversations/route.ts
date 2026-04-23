import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// GET — list all conversations, newest first
export async function GET() {
  const conversations = await prisma.chatConversation.findMany({
    orderBy: { updatedAt: 'desc' },
    include: { _count: { select: { messages: true } } },
    take: 50,
  })
  return NextResponse.json(conversations)
}

// POST — create a new conversation
export async function POST(req: NextRequest) {
  const { title } = await req.json()
  const conversation = await prisma.chatConversation.create({
    data: { title: title?.trim()?.slice(0, 80) || 'New conversation' },
  })
  return NextResponse.json(conversation, { status: 201 })
}
