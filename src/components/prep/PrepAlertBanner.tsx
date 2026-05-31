import React from 'react'
import { IcAlert, IcX } from '@/components/prep/icons'

interface PrepAlertBannerProps {
  message: React.ReactNode
  /** Short one-line summary for the mobile strip. Falls back to `message` if omitted. */
  compact?: React.ReactNode
  onDismiss: () => void
}

export default function PrepAlertBanner({ message, compact, onDismiss }: PrepAlertBannerProps) {
  return (
    <>
      {/* Mobile — slim one-line strip (details live in the critical rows below). */}
      <div className="sm:hidden flex items-center gap-2 px-3 py-2 rounded-lg mb-2.5 border border-[#fcd34d] bg-[#fffbeb]">
        <IcAlert className="w-[14px] h-[14px] text-gold-2 shrink-0" />
        <span className="flex-1 min-w-0 truncate text-[12px] text-[#78350f]">{compact ?? message}</span>
        <button type="button" onClick={onDismiss} className="text-gold-2 opacity-70 active:opacity-100 p-0.5 shrink-0" title="Dismiss">
          <IcX className="w-[14px] h-[14px]" />
        </button>
      </div>

      {/* Desktop — full card */}
      <div className="hidden sm:flex items-start gap-3 px-4 py-3.5 rounded-xl mb-[18px] border border-[#fcd34d] bg-gradient-to-b from-[#fffbeb] to-[#fef9ec]">
        <div className="w-[30px] h-[30px] bg-paper border border-[#fcd34d] rounded-lg grid place-items-center text-gold-2 shrink-0">
          <IcAlert className="w-4 h-4" />
        </div>
        <div className="flex-1 text-[13px] text-[#78350f] leading-[1.45]">{message}</div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-gold-2 opacity-70 hover:opacity-100 p-1.5"
          title="Dismiss"
        >
          <IcX className="w-[15px] h-[15px]" />
        </button>
      </div>
    </>
  )
}
