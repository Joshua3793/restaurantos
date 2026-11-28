'use client'
// Scan → find the item. The one flow every "scan" button uses:
//   camera reads a barcode → look it up → onItem(item)
//   unknown barcode → "which item is it?" → link it → onItem(item)
// The caller decides what finding the item means (reveal the count line,
// pick it on the waste form, open its drawer).
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, WifiOff } from 'lucide-react'
import { BarcodeScanSheet } from './BarcodeScanSheet'
import { LinkBarcodeSheet, type ScannedItem } from './LinkBarcodeSheet'
import { barcodeVariants } from '@/lib/barcode'
import { useBackDismiss } from '@/lib/back-stack'

export type { ScannedItem }

type Step =
  | { kind: 'scan' }
  | { kind: 'looking'; code: string }
  | { kind: 'link'; code: string }
  | { kind: 'error'; code: string }

/** The active item a barcode belongs to, or null. Throws when offline/failing. */
export async function lookupBarcode(code: string): Promise<ScannedItem | null> {
  for (const c of barcodeVariants(code)) {
    const res = await fetch(`/api/inventory/search?barcode=${encodeURIComponent(c)}`)
    if (!res.ok) throw new Error(`lookup ${res.status}`)
    const rows: ScannedItem[] = await res.json()
    if (Array.isArray(rows) && rows[0]) return { id: rows[0].id, itemName: rows[0].itemName }
  }
  return null
}

export function ScanItemFlow({
  open, onClose, onItem, title,
}: {
  open: boolean
  onClose: () => void
  /** Called once with the item; the flow closes itself first. */
  onItem: (item: ScannedItem, code: string) => void
  title?: string
}) {
  const [step, setStep] = useState<Step>({ kind: 'scan' })
  useEffect(() => { if (open) setStep(s => (s.kind === 'scan' ? s : { kind: 'scan' })) }, [open])
  // The scanner and link sheets register themselves; this covers the
  // "looking up" / "could not look up" card between them.
  useBackDismiss(open && (step.kind === 'looking' || step.kind === 'error'), onClose)

  const done = (item: ScannedItem, code: string) => { onClose(); onItem(item, code) }

  const lookup = async (code: string) => {
    setStep({ kind: 'looking', code })
    try {
      const item = await lookupBarcode(code)
      if (item) done(item, code)
      else setStep({ kind: 'link', code })
    } catch {
      setStep({ kind: 'error', code })
    }
  }

  if (!open) return null
  return (
    <>
      <BarcodeScanSheet open={step.kind === 'scan'} onClose={onClose} onResult={lookup} title={title} />
      <LinkBarcodeSheet
        open={step.kind === 'link'}
        code={step.kind === 'link' ? step.code : ''}
        onClose={onClose}
        onLinked={item => step.kind === 'link' && done(item, step.code)}
        onScanAgain={() => setStep(s => (s.kind === 'scan' ? s : { kind: 'scan' }))}
      />
      {(step.kind === 'looking' || step.kind === 'error') && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[105] bg-black/70 text-white grid place-items-center px-6" role="dialog" aria-label="Looking up barcode">
          {step.kind === 'looking' ? (
            <div className="flex flex-col items-center gap-3 text-[16px]">
              <Loader2 size={28} className="animate-spin" /> Looking up {step.code}…
            </div>
          ) : (
            <div className="w-full max-w-sm rounded-2xl bg-paper text-ink p-4 flex flex-col gap-3">
              <div className="flex items-center gap-2 text-[17px] font-semibold"><WifiOff size={18} /> Could not look that up</div>
              <div className="text-[16px] text-ink-3">No signal, or the app is busy. Barcode {step.code}.</div>
              <div className="flex gap-2">
                <button onClick={onClose} className="flex-1 h-11 rounded-[10px] border border-line text-[16px]">Close</button>
                <button onClick={() => lookup(step.code)} className="flex-1 h-11 rounded-[10px] bg-ink text-paper text-[16px] font-semibold">Try again</button>
              </div>
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}
