'use client'
import { useEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import type { TagLite } from '@/lib/inbox/rules'

// Add or change one Inbox tag, as a bottom sheet on the phone and a centred
// card on desktop. Built-in tags show name + colour only. Never blurred.

export const TAG_NAME_MAX = 24

// Mirrors TAG_PALETTE in src/lib/inbox/tags.ts (that file is server-only).
const PALETTE = [
  ['Grey', '#71717a'], ['Red', '#dc2626'], ['Amber', '#ca8a04'], ['Orange', '#ea580c'],
  ['Green', '#16a34a'], ['Pink', '#db2777'], ['Teal', '#0d9488'], ['Blue', '#2563eb'],
] as const

export type TagDraft = { name: string; color: string; cookCanPick: boolean }

function Dot({ name, hex, on, onPick }: { name: string; hex: string; on: boolean; onPick?: () => void }) {
  return (
    <button
      type="button"
      aria-label={name}
      aria-pressed={on}
      disabled={!onPick}
      onClick={onPick}
      className="w-11 h-11 grid place-items-center rounded-full disabled:cursor-default"
    >
      <span
        className="block w-9 h-9 rounded-full"
        style={{
          background: hex,
          border: `3px solid ${on ? '#09090b' : '#ffffff'}`,
          boxShadow: '0 0 0 1px #e4e4e7',
        }}
      />
    </button>
  )
}

export function TagSheet({ tag, busy, onSave, onRemove, onClose }: {
  /** null = a new tag. */
  tag: TagLite | null
  busy: boolean
  onSave: (draft: TagDraft) => void
  onRemove: () => void
  onClose: () => void
}) {
  const builtIn = !!tag?.builtIn
  const [name, setName] = useState(tag?.name ?? '')
  const [color, setColor] = useState(tag?.color ?? PALETTE[0][1])
  const [cookCanPick, setCookCanPick] = useState(tag?.cookCanPick ?? true)
  const [confirming, setConfirming] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => { if (!tag) nameRef.current?.focus() }, [tag])

  // A colour outside the palette (Money's purple) is shown as it is, not pickable.
  const offPalette = !!tag && !PALETTE.some(([, hex]) => hex === tag.color.toLowerCase())
  const trimmed = name.trim()
  const canSave = trimmed.length > 0 && !busy

  return (
    <div className="fixed inset-0 z-[60] flex items-end md:items-center justify-center" role="presentation">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <form
        role="dialog"
        aria-modal="true"
        aria-label={tag ? `Change ${tag.name}` : 'New tag'}
        onSubmit={e => { e.preventDefault(); if (canSave) onSave({ name: trimmed, color, cookCanPick }) }}
        className="relative w-full max-w-[480px] bg-paper rounded-t-[22px] md:rounded-[22px] px-4 pt-2.5 pb-[calc(20px+env(safe-area-inset-bottom))] flex flex-col gap-3.5 max-h-[92vh] overflow-y-auto"
      >
        <div className="self-center w-10 h-1 rounded-full bg-line-2 md:hidden" />
        <div className="font-mono text-[10px] tracking-[0.08em] text-ink-3">
          {tag ? (builtIn ? 'BUILT-IN TAG' : 'CHANGE TAG') : 'NEW TAG'}
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] text-ink-2">Name</span>
          <input
            ref={nameRef}
            type="text"
            value={name}
            maxLength={TAG_NAME_MAX}
            onChange={e => setName(e.target.value)}
            className="h-[46px] border border-line-2 rounded-[9px] px-3 text-[15px] bg-paper"
          />
        </label>

        <div role="group" aria-label="Colour" className="flex flex-wrap -ml-1">
          {PALETTE.map(([n, hex]) => (
            <Dot key={hex} name={n} hex={hex} on={color === hex} onPick={() => setColor(hex)} />
          ))}
          {offPalette && tag && <Dot name="Current colour" hex={tag.color} on={color === tag.color} />}
        </div>

        {!builtIn && (
          <div className="flex items-center gap-3 min-h-[44px]">
            <span id="cook-can-pick" className="flex-1 text-[14px]">Cooks can pick it</span>
            <button
              type="button"
              role="switch"
              aria-checked={cookCanPick}
              aria-labelledby="cook-can-pick"
              onClick={() => setCookCanPick(v => !v)}
              className={`relative flex-none w-[52px] h-8 rounded-full ${cookCanPick ? 'bg-green' : 'bg-line-2'}`}
            >
              <span
                className={`absolute top-[3px] w-[26px] h-[26px] rounded-full bg-paper transition-[left] ${cookCanPick ? 'left-[23px]' : 'left-[3px]'}`}
              />
            </button>
          </div>
        )}

        {confirming ? (
          <div className="flex flex-col gap-2.5 border border-line rounded-xl p-3.5" role="alertdialog" aria-label="Remove this tag">
            <p className="m-0 text-[14px] text-ink">Remove {tag?.name}? Items already filed keep it.</p>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirming(false)}
                className="min-h-[46px] rounded-xl border border-line-2 bg-paper text-[14px] font-medium text-ink-2 disabled:opacity-50"
              >
                Keep it
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={onRemove}
                className="min-h-[46px] rounded-xl bg-red text-paper text-[14px] font-medium disabled:opacity-50"
              >
                Remove
              </button>
            </div>
          </div>
        ) : (
          <>
            <button
              type="submit"
              disabled={!canSave}
              className="min-h-[50px] rounded-xl bg-ink text-paper text-[14px] font-medium inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
            >
              {tag ? 'Save' : 'Add tag'} <Check size={16} strokeWidth={3} className="text-gold" aria-hidden />
            </button>
            {tag && !builtIn && (
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirming(true)}
                className="min-h-[44px] text-[13.5px] font-medium text-red-text disabled:opacity-50"
              >
                Remove
              </button>
            )}
          </>
        )}
      </form>
    </div>
  )
}
