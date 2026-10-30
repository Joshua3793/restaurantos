import { NextResponse, type NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { atLeast } from '@/lib/roles'
import { checkLock, clientIp, recordAttempt } from '@/lib/pin/attempts'
import { PinError } from '@/lib/pin/errors'
import { PIN_FORMAT, pinErrorResponse, readBody, readDeviceToken } from '@/lib/pin/http'
import { hashToken } from '@/lib/pin/rules'

// Public: a manager standing next to the cook types their own PIN on the
// cook's phone. Never log the PIN or token.
export const dynamic = 'force-dynamic'

/** POST { managerPin } — approves every PENDING request on this phone. */
export async function POST(req: NextRequest) {
  const body = await readBody(req)
  const pin = typeof body.managerPin === 'string' ? body.managerPin : null
  const token = readDeviceToken(req)
  try {
    const ipKey = `ip:${clientIp(req)}`
    await checkLock([ipKey])

    if (!pin || !PIN_FORMAT.test(pin)) throw new PinError(400, 'Enter your PIN')

    const cook = await prisma.cook.findFirst({
      where: { clockId: pin, isActive: true },
      select: {
        id: true,
        user: { select: { id: true, name: true, email: true, role: true, isActive: true } },
      },
    })
    const keys = cook ? [ipKey, `cook:${cook.id}`] : [ipKey]
    if (cook) await checkLock([`cook:${cook.id}`])

    const manager = cook?.user
    if (!manager || !manager.isActive || !atLeast(manager.role, 'MANAGER')) {
      await recordAttempt(keys, false)
      throw new PinError(403, 'Only a manager can OK a phone')
    }

    if (!token) throw new PinError(400, 'Nothing to approve on this phone')

    const { count } = await prisma.pinDevice.updateMany({
      where: { tokenHash: hashToken(token), status: 'PENDING' },
      data: {
        status: 'APPROVED',
        approvedById: manager.id,
        approvedByName: manager.name?.trim() || manager.email.split('@')[0],
        approvedAt: new Date(),
      },
    })
    await recordAttempt(keys, true)
    return NextResponse.json({ approved: count })
  } catch (e) {
    return pinErrorResponse('POST /api/auth/pin/approve-here', e, [pin, token])
  }
}
