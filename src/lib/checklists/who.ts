import 'server-only'
import { prisma } from '@/lib/prisma'

type NameSource = { id: string; name: string | null; email: string }

/**
 * The name shown for a person on the checklists: the linked cook's name when
 * that cook is active, else the login's own name, else the part of the email
 * before the "@". Never the full email address.
 */
export async function displayName(user: NameSource): Promise<string> {
  const cook = await prisma.cook.findUnique({
    where: { userId: user.id },
    select: { name: true, isActive: true },
  })
  const cookName = cook?.isActive ? cook.name?.trim() : ''
  if (cookName) return cookName
  const own = user.name?.trim()
  if (own) return own
  return user.email.split('@')[0] || user.email
}

/** The id + display name stored on lines and crew rows. */
export async function whoOf(user: NameSource): Promise<{ id: string; name: string }> {
  return { id: user.id, name: await displayName(user) }
}
