import 'server-only'
import { NextResponse, type NextRequest } from 'next/server'
import { PinError } from '@/lib/pin/errors'

/** The long-lived cookie that names this phone. Only its hash is stored. */
export const PIN_DEVICE_COOKIE = 'pin_device'

/** Read at request time so `secure` follows the running environment. */
export function pinDeviceCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 400 * 24 * 3600,
  }
}

/** PINs are the Toast clock-in numbers as they are: 3–8 digits, never padded. */
export const PIN_FORMAT = /^\d{3,8}$/

/** The exact shape `newDeviceToken` mints (32 bytes, base64url). */
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/

/** True when `value` has the shape of a token we could have issued. */
export function isDeviceToken(value: string | null | undefined): value is string {
  return !!value && TOKEN_FORMAT.test(value)
}

/** The phone's device token, or null when absent or not one we could have issued. */
export function readDeviceToken(req: NextRequest): string | null {
  const value = req.cookies.get(PIN_DEVICE_COOKIE)?.value
  return isDeviceToken(value) ? value : null
}

/**
 * The request body as an object, or {} when it is not valid JSON. A request
 * not sent as `application/json` is refused with 415 before the body is read:
 * a cross-site form post (text/plain, form-encoded) can't send that type
 * without a CORS preflight, which this route never answers.
 */
export async function readBody(req: NextRequest): Promise<Record<string, unknown>> {
  const type = req.headers.get('content-type')?.trim().toLowerCase() ?? ''
  if (!type.startsWith('application/json')) throw new PinError(415, 'Bad request')
  try {
    const body: unknown = await req.json()
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * A PinError becomes its status + `{ error }`. Anything else is logged with
 * every secret (PIN, device token) redacted and answered with a generic 500 —
 * an unknown error's message is never sent to the phone.
 */
export function pinErrorResponse(label: string, e: unknown, secrets: (string | null | undefined)[]): NextResponse {
  if (e instanceof PinError) return NextResponse.json({ error: e.message }, { status: e.status })
  console.error(label, redact(e, secrets))
  return NextResponse.json({ error: 'Could not sign in — try again' }, { status: 500 })
}

function redact(e: unknown, secrets: (string | null | undefined)[]): string {
  const name = e instanceof Error ? e.name : typeof e
  const code = typeof e === 'object' && e !== null && 'code' in e ? ` [${String((e as { code: unknown }).code)}]` : ''
  let message = e instanceof Error ? e.message : ''
  for (const s of secrets) if (s) message = message.split(s).join('***')
  return `${name}${code}: ${message}`
}
