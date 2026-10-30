import { NextResponse, type NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { pinErrorResponse, readDeviceToken } from '@/lib/pin/http'
import { hashToken, pairCode, pinDisplayName } from '@/lib/pin/rules'

// Public: the waiting screen polls this. Never log the token.
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

/** GET — this phone's sign-in requests (newest first, at most 5) and its pair code. */
export async function GET(req: NextRequest) {
  const token = readDeviceToken(req)
  try {
    if (!token) return NextResponse.json({ devices: [] }, { headers: NO_STORE })
    const tokenHash = hashToken(token)
    const rows = await prisma.pinDevice.findMany({
      where: { tokenHash },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { status: true, cook: { select: { name: true, lastName: true } } },
    })
    const devices = rows.map((r) => ({ cookName: pinDisplayName(r.cook), status: r.status }))
    // The pair code lets the manager match this phone to its request.
    const body = devices.length ? { devices, pairCode: pairCode(tokenHash) } : { devices }
    return NextResponse.json(body, { headers: NO_STORE })
  } catch (e) {
    return pinErrorResponse('GET /api/auth/pin/status', e, [token])
  }
}
