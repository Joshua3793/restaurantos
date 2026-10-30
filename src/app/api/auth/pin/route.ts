import { NextResponse, type NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { assertPinLoginAllowed, ensurePinUser, mintSession } from '@/lib/pin/account'
import { checkLock, clientIp, recordAttempt } from '@/lib/pin/attempts'
import { PinError } from '@/lib/pin/errors'
import {
  PIN_DEVICE_COOKIE,
  PIN_DEVICE_COOKIE_OPTIONS,
  PIN_FORMAT,
  pinErrorResponse,
  readBody,
  readDeviceToken,
} from '@/lib/pin/http'
import { deviceLabel, hashToken, newDeviceToken, pinDisplayName } from '@/lib/pin/rules'

// Public (no requireSession): this IS the sign-in. Never log the PIN or token.
export const dynamic = 'force-dynamic'

/**
 * POST { pin, confirm? } — a cook signs in on their own phone.
 *  - approved phone → a normal session (cookies set) → { signedIn: true }
 *  - otherwise → { needsConfirm, name } so the cook can check it is them,
 *    then with confirm → this phone is queued for a manager → { pending, name }
 */
export async function POST(req: NextRequest) {
  const body = await readBody(req)
  const pin = typeof body.pin === 'string' ? body.pin : null
  const token = readDeviceToken(req)
  try {
    const ipKey = `ip:${clientIp(req)}`
    await checkLock([ipKey])

    if (!pin || !PIN_FORMAT.test(pin)) throw new PinError(400, 'Enter your PIN')

    const cook = await prisma.cook.findFirst({
      where: { clockId: pin, isActive: true },
      select: { id: true, name: true, lastName: true, userId: true },
    })
    if (!cook) {
      await recordAttempt([ipKey], false)
      throw new PinError(401, 'PIN not recognised')
    }

    const cookKey = `cook:${cook.id}`
    await checkLock([cookKey])

    // Managers (and switched-off logins) are refused here, before any phone
    // is queued. A right PIN, so not counted as a failed try.
    await assertPinLoginAllowed(cook)

    const name = pinDisplayName(cook)
    const tokenHash = token ? hashToken(token) : null
    const device = tokenHash
      ? await prisma.pinDevice.findUnique({
          where: { tokenHash_cookId: { tokenHash, cookId: cook.id } },
          select: { id: true, status: true },
        })
      : null

    if (device?.status === 'APPROVED') {
      const { email } = await ensurePinUser(cook)
      const sessionCookies = await mintSession(req, email)
      await prisma.pinDevice.update({ where: { id: device.id }, data: { lastUsedAt: new Date() } })
      await recordAttempt([ipKey, cookKey], true)
      const res = NextResponse.json({ signedIn: true })
      for (const { name: cookieName, value, options } of sessionCookies) {
        res.cookies.set(cookieName, value, options)
      }
      return res
    }

    if (body.confirm !== true) return NextResponse.json({ needsConfirm: true, name })

    const deviceToken = token ?? newDeviceToken()
    const hash = tokenHash ?? hashToken(deviceToken)
    const reopen = device?.status === 'REJECTED' || device?.status === 'REVOKED'
    await prisma.pinDevice.upsert({
      where: { tokenHash_cookId: { tokenHash: hash, cookId: cook.id } },
      create: { tokenHash: hash, cookId: cook.id, status: 'PENDING', label: deviceLabel(req.headers.get('user-agent')) },
      update: reopen
        ? { status: 'PENDING', createdAt: new Date(), approvedById: null, approvedByName: null, approvedAt: null }
        : {},
    })
    const res = NextResponse.json({ pending: true, name })
    res.cookies.set(PIN_DEVICE_COOKIE, deviceToken, PIN_DEVICE_COOKIE_OPTIONS)
    return res
  } catch (e) {
    return pinErrorResponse('POST /api/auth/pin', e, [pin, token])
  }
}
