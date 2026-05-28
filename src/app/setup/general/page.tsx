'use client'
import { Bell } from 'lucide-react'
import { PageHead } from '@/components/layout/PageHead'

export default function GeneralSettingsPage() {
  return (
    <div>
      <PageHead
        crumbs={<><Bell size={12} /> SETUP / GENERAL</>}
        title="General"
        sub={<>App-wide settings — email digest schedule, notifications, brand.</>}
      />
      <div className="bg-paper border border-line rounded-[12px] p-12 text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3">Coming soon</p>
        <p className="text-[14px] text-ink-2 mt-2 max-w-md mx-auto">
          Email digest configuration, notification preferences, and tenant-level brand
          settings live here. The digest endpoint is already wired
          at <span className="font-mono text-gold-2">/api/digest</span>.
        </p>
      </div>
    </div>
  )
}
