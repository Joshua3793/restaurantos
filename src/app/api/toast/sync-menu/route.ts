import { NextResponse } from 'next/server'
import { requireSession, AuthError } from '@/lib/auth'
import { syncToastMenu } from '@/lib/toast/menu-sync'

export const dynamic = 'force-dynamic'

/**
 * POST /api/toast/sync-menu — pull the published Toast menu and upsert
 * `ToastItemMap` rows (GUID + name + group + menu). ADMIN-only. Idempotent;
 * preserves existing `recipeId` mappings.
 */
export async function POST() {
  try {
    await requireSession('ADMIN')
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    throw e
  }

  try {
    const result = await syncToastMenu()
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    )
  }
}
