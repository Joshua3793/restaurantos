'use client'
import { useEffect, useState } from 'react'
import { Mail, AlertCircle, AlertTriangle } from 'lucide-react'
import { SubNav } from '@/components/layout/SubNav'

interface Counts {
  invoices: number      // awaiting approval
  priceAlerts: number   // unacknowledged
  exceptions: number    // unmatched lines + dupes
}

export function InboxSubNav() {
  const [counts, setCounts] = useState<Counts>({ invoices: 0, priceAlerts: 0, exceptions: 0 })

  useEffect(() => {
    const load = async () => {
      try {
        const [k, a] = await Promise.all([
          fetch('/api/invoices/kpis', { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
          fetch('/api/invoices/alerts', { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
        ])
        setCounts({
          invoices:    k?.awaitingApprovalCount ?? 0,
          priceAlerts: a?.priceAlerts?.length ?? 0,
          exceptions:  k?.exceptionsCount ?? 0,
        })
      } catch {}
    }
    load()
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [])

  return (
    <SubNav
      tabs={[
        { href: '/invoices',                label: 'Invoices',     icon: <BadgeIcon icon={<Mail size={13} />}        n={counts.invoices} /> },
        { href: '/invoices/price-alerts',   label: 'Price alerts', icon: <BadgeIcon icon={<AlertTriangle size={13} />} n={counts.priceAlerts} /> },
        { href: '/invoices/exceptions',     label: 'Exceptions',   icon: <BadgeIcon icon={<AlertCircle size={13} />}  n={counts.exceptions} /> },
      ]}
    />
  )
}

function BadgeIcon({ icon, n }: { icon: React.ReactNode; n: number }) {
  return (
    <span className="relative inline-flex items-center">
      {icon}
      {n > 0 && (
        <span className="font-mono text-[9.5px] bg-gold text-ink font-semibold ml-1.5 px-1.5 py-px rounded-full leading-none">
          {n > 99 ? '99+' : n}
        </span>
      )}
    </span>
  )
}
