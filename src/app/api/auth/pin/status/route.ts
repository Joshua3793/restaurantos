import { NextResponse, type NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { pinErrorResponse, readDeviceToken } from '@/lib/pin/http'
import { hashToken, pinDisplayName } from '@/lib/pin/rules'

// Public: the waiting screen polls this. Never log the token.
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

/** GET — this phone's sign-in requests (newest first, at most 5). */
export async function GET(req: NextRequest) {
  const token = readDeviceToken(req)
  try {
    if (!token) return NextResponse.json({ devices: [] }, { headers: NO_STORE })
    const rows = await prisma.pinDevice.findMany({
      where: { tokenHash: hashToken(token) },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { status: true, cook: { select: { name: true, lastName: true } } },
    })
    const devices = rows.map((r) => ({ cookName: pinDisplayName(r.cook), status: r.status }))
    return NextResponse.json({ devices }, { headers: NO_STORE })
  } catch (e) {
    return pinErrorResponse('GET /api/auth/pin/status', e, [token])
  }
}
