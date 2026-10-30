import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { isPinEmail } from '@/lib/pin/rules'

// People-side guards for PIN accounts (RULING P9): a cook's PIN is printed on
// clock reports, so a PIN login is never raised above LEAD, and the PIN
// sign-in domain is never invited as an ordinary email login.

/** Refusal when someone tries to make a PIN login a manager (409). */
export const PIN_NEEDS_EMAIL_LOGIN =
  'This cook signs in with a PIN — give them an email login to make them a manager'

/** Refusal when someone invites an address on the PIN sign-in domain (400). */
export const PIN_EMAIL_NOT_INVITABLE =
  'That address is a PIN sign-in — invite the person’s own email instead'

/**
 * True when `user` is a PIN account. Prefers the auth stamp
 * (`app_metadata.pinCookId`, written only by the service role); if the auth
 * user can't be read or has no stamp, falls back to the PIN email domain.
 */
export async function isPinAccount(
  admin: SupabaseClient,
  user: { id: string; email: string | null },
): Promise<boolean> {
  try {
    const { data, error } = await admin.auth.admin.getUserById(user.id)
    const stamp = error ? undefined : data?.user?.app_metadata?.pinCookId
    if (stamp !== undefined && stamp !== null) return true
  } catch {
    // Unreadable: fall back to the email below.
  }
  return isPinEmail(user.email)
}
