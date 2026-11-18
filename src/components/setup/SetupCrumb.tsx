'use client'
import Link from 'next/link'
import type { Role } from '@prisma/client'
import { useUser } from '@/contexts/UserContext'
import { atLeast } from '@/lib/roles'

// "← Setup / People / Phone sign-ins" over a Setup page a manager can also
// open. Only an admin can open Setup itself, so a manager sees the plain trail.
export function SetupCrumb({ trail }: { trail: { label: string; href?: string }[] }) {
  const { role } = useUser()
  const admin = !!role && atLeast(role as Role, 'ADMIN')
  const parts = [{ label: 'Setup', href: '/setup' }, ...trail]
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 font-mono text-[11px] text-ink-3 min-h-[28px]">
      {parts.map((p, i) => (
        <span key={p.label} className="flex items-center gap-1.5">
          {i > 0 && <span aria-hidden>/</span>}
          {p.href && admin && i < parts.length - 1
            ? <Link href={p.href} className="text-gold-2 hover:underline">{i === 0 ? '← ' : ''}{p.label}</Link>
            : <span className={i === parts.length - 1 ? 'text-ink-2' : ''}>{p.label}</span>}
        </span>
      ))}
    </nav>
  )
}
