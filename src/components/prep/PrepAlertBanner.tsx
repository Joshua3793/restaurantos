import React from 'react'
import { IcAlert, IcX } from '@/components/prep/icons'

interface PrepAlertBannerProps {
  message: React.ReactNode
  onDismiss: () => void
}

export default function PrepAlertBanner({ message, onDismiss }: PrepAlertBannerProps) {
  return (
    <div className="flex items-start gap-3 px-4 py-3.5 rounded-xl mb-[18px] border border-[#fcd34d] bg-gradient-to-b from-[#fffbeb] to-[#fef9ec]">
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
  )
}
