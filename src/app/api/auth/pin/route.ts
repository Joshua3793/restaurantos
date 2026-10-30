import { NextResponse, type NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { assertPinLoginAllowed, ensurePinUser, mintSession } from '@/lib/pin/account'
import { checkLock, clientIp, confirmKey, recordAttempt } from '@/lib/pin/attempts'
import { PinError } from '@/lib/pin/errors'
import {
  PIN_DEVICE_COOKIE,
  PIN_FORMAT,
  pinDeviceCookieOptions,
  pinErrorResponse,
  readBody,
  readDeviceToken,
} from '@/lib/pin/http'
import { PENDING_MAX_AGE_MS, deviceLabel, hashToken, newDeviceToken, pinDisplayName } from '@/lib/pin/rules'

// Public (no requireSession): this IS the sign-in. Never log the PIN or token.
export const dynamic = 'force-dynamic'

/**
 * POST { pin, confirm? } — a cook signs in on their own phone.
 *  - approved phone → a normal session (cookies set) → { signedIn: true }
 *  - otherwise → { needsConfirm, name } so the cook can check it is them,
 *    then with confirm → this phone is queued for a manager → { pending, name }
 *    (or { rejected, name } when a manager already said no to this phone).
 * Phones are OK'd only from a manager's own signed-in session (RULING P6).
 */
export async function POST(req: NextRequest) {
  const body = await readBody(req)
  const pin = typeof body.pin === 'string' ? body.pin : null
  const token = readDeviceToken(req)
  try {
    const ip = clientIp(req)
    const ipKey = `ip:${ip}`
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
    const keys = [ipKey, cookKey]
    // Nothing writes `cook:` failures since approve-here went; kept as a cheap guard for future failure writers.
    await checkLock([cookKey])

    // Managers (and switched-off logins) are refused here, before any phone
    // is queued. A right PIN: recorded ok (audit trail), never a failure.
    try {
      await assertPinLoginAllowed(cook)
    } catch (e) {
      if (e instanceof PinError) await recordAttempt(keys, true)
      throw e
    }

    const name = pinDisplayName(cook)
    const tokenHash = token ? hashToken(token) : null
    const device = tokenHash
      ? await prisma.pinDevice.findUnique({
          where: { tokenHash_cookId: { tokenHash, cookId: cook.id } },
          select: { id: true, status: true, createdAt: true },
        })
      : null

    if (device?.status === 'APPROVED') {
      const { email } = await ensurePinUser(cook)
      const sessionCookies = await mintSession(req, email)
      await prisma.pinDevice.update({ where: { id: device.id }, data: { lastUsedAt: new Date() } })
      await recordAttempt(keys, true)
      const res = NextResponse.json({ signedIn: true })
      for (const { name: cookieName, value, options } of sessionCookies) {
        res.cookies.set(cookieName, value, options)
      }
      return res
    }

    if (body.confirm !== true) {
      await recordAttempt(keys, true)
      return NextResponse.json({ needsConfirm: true, name })
    }

    // A manager said no to this phone for this cook: that sticks.
    if (device?.status === 'REJECTED') {
      await recordAttempt(keys, true)
      return NextResponse.json({ rejected: true, name })
    }

    const staleBefore = new Date(Date.now() - PENDING_MAX_AGE_MS)

    // Pressed again on a phone already waiting (fresh) for this cook: nothing to
    // do, and it must not spend the confirm budget the whole kitchen Wi-Fi shares.
    if (token && device?.status === 'PENDING' && device.createdAt >= staleBefore) {
      await recordAttempt(keys, true)
      const res = NextResponse.json({ pending: true, name })
      res.cookies.set(PIN_DEVICE_COOKIE, token, pinDeviceCookieOptions())
      return res
    }

    const cKey = confirmKey(ip)
    await checkLock([cKey])
    await recordAttempt([...keys, cKey], true)

    const deviceToken = token ?? newDeviceToken()
    const hash = tokenHash ?? hashToken(deviceToken)
    let opened = false
    if (device?.status === 'PENDING') {
      // Stale (a manager can no longer approve it): restart its clock.
      const { count } = await prisma.pinDevice.updateMany({
        where: { tokenHash: hash, cookId: cook.id, status: 'PENDING', createdAt: { lt: staleBefore } },
        data: { createdAt: new Date() },
      })
      opened = count > 0
    } else if (device?.status === 'REVOKED') {
      // Conditional: only a row that is STILL revoked reopens.
      const { count } = await prisma.pinDevice.updateMany({
        where: { tokenHash: hash, cookId: cook.id, status: 'REVOKED' },
        data: { status: 'PENDING', createdAt: new Date(), approvedById: null, approvedByName: null, approvedAt: null },
      })
      opened = count > 0
    } else if (!device) {
      // `update: {}` — a row another request made meanwhile is left alone.
      await prisma.pinDevice.upsert({
        where: { tokenHash_cookId: { tokenHash: hash, cookId: cook.id } },
        create: { tokenHash: hash, cookId: cook.id, status: 'PENDING', label: deviceLabel(req.headers.get('user-agent')) },
        update: {},
      })
      opened = true
    }
    if (opened) await capPending(cook.id)

    const res = NextResponse.json({ pending: true, name })
    res.cookies.set(PIN_DEVICE_COOKIE, deviceToken, pinDeviceCookieOptions())
    return res
  } catch (e) {
    return pinErrorResponse('POST /api/auth/pin', e, [pin, token])
  }
}

/** Pending requests kept per cook; older ones are dropped as new ones come in. */
const MAX_PENDING_PER_COOK = 3

async function capPending(cookId: string): Promise<void> {
  const extra = await prisma.pinDevice.findMany({
    where: { cookId, status: 'PENDING' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: MAX_PENDING_PER_COOK,
    select: { id: true },
  })
  if (extra.length === 0) return
  await prisma.pinDevice.deleteMany({ where: { id: { in: extra.map((d) => d.id) }, status: 'PENDING' } })
}
