'use client'
import Link from 'next/link'
import { Lock } from 'lucide-react'
import type { Role } from '@prisma/client'
import { ROLE_LABELS } from '@/lib/roles'
import { useUser } from '@/contexts/UserContext'

/**
 * Shown in place of a page the current clearance cannot open. Rendered by a
 * middleware REWRITE, so the URL is still the page the user asked for — which
 * is the point: no silent bounce, and the sidebar stays available.
 *
 * `pageLabel` and `need` arrive as props, NOT from useSearchParams(): a rewrite
 * leaves the browser URL untouched, so the client router cannot see the params
 * middleware attached.
 */
export function NoAccessCard({
  pageLabel,
  need,
}: {
  pageLabel: string | null
  need: Role | null
}) {
  const { role } = useUser()
  const target = pageLabel ?? 'this page'
  const needLabel = need ? ROLE_LABELS[need] : null

  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-4">
      <span className="grid place-items-center w-14 h-14 rounded-2xl bg-bg-2 text-ink-3 mb-5">
        <Lock size={24} />
      </span>

      <h1 className="text-[24px] font-semibold text-ink tracking-[-0.03em] m-0">
        You don&rsquo;t have access to {target}
      </h1>

      <p className="text-[14px] text-ink-2 mt-3 max-w-[420px] leading-relaxed">
        {needLabel
          ? <>This page needs <strong className="text-ink font-semibold">{needLabel}</strong> clearance. Ask your manager to raise your access if you need it.</>
          : <>Ask your manager to raise your access if you need this page.</>}
      </p>

      {role && (
        <p className="font-mono text-[11px] text-ink-3 mt-4">
          Your clearance: {ROLE_LABELS[role]}
        </p>
      )}

      <Link
        href="/today"
        className="mt-7 inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-ink text-paper text-[13.5px] font-medium hover:opacity-90 transition-opacity"
      >
        Back to Today
      </Link>
    </div>
  )
}
