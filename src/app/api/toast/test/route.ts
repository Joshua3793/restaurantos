import { NextResponse } from 'next/server'
import { requireSession, AuthError } from '@/lib/auth'
import { testConnection } from '@/lib/toast/client'

export const dynamic = 'force-dynamic'

/**
 * GET /api/toast/test — verifies Toast credentials end-to-end (auth → restaurant
 * info → yesterday's order count). ADMIN-only. Read-only; safe to call anytime.
 * Used to confirm the connection before building the rest of the sync.
 */
export async function GET() {
  try {
    await requireSession('ADMIN')
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    throw e
  }

  const result = await testConnection()
  return NextResponse.json(result, { status: result.ok ? 200 : 502 })
}
