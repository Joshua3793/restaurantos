import { NextResponse } from 'next/server'
import { requireSession, AuthError } from '@/lib/auth'

export async function GET() {
  try {
    const user = await requireSession()
    return NextResponse.json({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    })
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
}
