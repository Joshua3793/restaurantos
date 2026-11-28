'use client'
import { ScanBarcode } from 'lucide-react'

/** The square "scan a barcode" button that sits beside a search box (44 px). */
export function ScanButton({ onClick, className = '', label = 'Scan a barcode', bare = false }: {
  onClick: () => void
  className?: string
  label?: string
  /** No border/background — for a button sitting inside a search field. */
  bare?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`shrink-0 w-11 h-11 grid place-items-center rounded-[10px] text-ink-2 active:bg-bg ${bare ? '' : 'border border-line bg-paper hover:border-ink-3'} ${className}`}
    >
      <ScanBarcode size={20} />
    </button>
  )
}
