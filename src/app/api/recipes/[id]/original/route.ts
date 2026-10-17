import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// GET /api/recipes/[id]/original — the photo/file a scanned recipe was read
// from. Any signed-in user (Joshua's decision: whoever sees the recipe can
// open its original, cooks included).
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const recipe = await prisma.recipe.findUnique({
    where: { id: params.id },
    select: {
      sourceScan: {
        select: { files: { select: { fileName: true, fileType: true, fileUrl: true }, orderBy: { sortOrder: 'asc' } } },
      },
    },
  })
  if (!recipe?.sourceScan) return NextResponse.json({ error: 'No original for this recipe' }, { status: 404 })
  return NextResponse.json({ files: recipe.sourceScan.files }, { headers: { 'Cache-Control': 'no-store' } })
}
