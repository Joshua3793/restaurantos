'use client'
import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { STATION_COLORS, NAME_MAX } from '@/lib/checklists/item-input'
import { chipName, phaseCount, type CategoryTree, type EditStation } from '@/lib/checklists/edit-format'
import type { Phase } from '@/lib/checklists/rules'

// Bottom sheets for the checklist editor: the shell every sheet shares, plus the
// station, category and "Copy from…" sheets. The item sheet lives in ItemSheet.tsx.

export function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center" role="presentation">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="relative w-full max-w-[480px] bg-paper rounded-t-[22px] px-4 pt-2.5 pb-[calc(20px+env(safe-area-inset-bottom))] flex flex-col gap-[18px] max-h-[92vh] overflow-y-auto"
      >
        <div className="self-center w-10 h-1 rounded-full bg-line-2 flex-none" />
        {children}
      </section>
    </div>
  )
}

export const FIELD_LABEL = 'font-mono text-[10px] font-medium tracking-[0.08em] text-ink-3'
export const INPUT = 'h-12 border border-line-2 rounded-[9px] px-3 text-[15px] text-ink bg-paper w-full'

export function SheetError({ error }: { error: string | null }) {
  if (!error) return null
  return <p role="alert" className="m-0 text-[13px] text-red-text">{error}</p>
}

/** "Remove Grill? Its history stays." with Keep / Remove. */
export function ConfirmRemove({ text, busy, onKeep, onRemove }: { text: string; busy: boolean; onKeep: () => void; onRemove: () => void }) {
  return (
    <div className="flex flex-col gap-3 bg-red-soft rounded-xl p-3.5">
      <p className="m-0 text-[14px] text-red-text font-medium">{text}</p>
      <div className="flex gap-2">
        <button type="button" onClick={onKeep} className="flex-1 min-h-[44px] rounded-[10px] border border-line-2 bg-paper text-[13.5px] font-medium text-ink-2">
          Keep it
        </button>
        <button type="button" disabled={busy} onClick={onRemove} className="flex-1 min-h-[44px] rounded-[10px] bg-red text-white text-[13.5px] font-medium disabled:opacity-50">
          Remove
        </button>
      </div>
    </div>
  )
}

export function SheetHeader({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="flex justify-between items-center gap-3">
      <h2 className="m-0 text-[20px] font-semibold tracking-[-0.03em]">{title}</h2>
      {meta && <span className="font-mono text-[10.5px] text-ink-3 text-right">{meta}</span>}
    </div>
  )
}

const COLOR_NAMES: Record<string, string> = {
  '#71717a': 'Grey', '#dc2626': 'Red', '#ca8a04': 'Yellow', '#ea580c': 'Orange',
  '#16a34a': 'Green', '#db2777': 'Pink', '#0d9488': 'Teal', '#2563eb': 'Blue',
}

/** New station, or rename / recolour / remove one. Resolves to an error message, or null when saved. */
export function StationSheet({
  station,
  onClose,
  onSave,
  onRemove,
}: {
  station: EditStation | null
  onClose: () => void
  onSave: (name: string, color: string) => Promise<string | null>
  onRemove: () => Promise<string | null>
}) {
  const [name, setName] = useState(station?.name ?? '')
  const [color, setColor] = useState<string>(station?.color ?? STATION_COLORS[0])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    const err = await onSave(name, color)
    setBusy(false)
    if (err) setError(err)
    else onClose()
  }
  const remove = async () => {
    if (busy) return
    setBusy(true)
    const err = await onRemove()
    setBusy(false)
    if (err) { setError(err); setConfirm(false) } else onClose()
  }

  return (
    <Sheet label={station ? 'Edit station' : 'New station'} onClose={onClose}>
      <form onSubmit={save} className="flex flex-col gap-[18px]">
        <SheetHeader title={station ? 'Edit station' : 'New station'} />
        <label className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL}>NAME</span>
          <input type="text" value={name} maxLength={NAME_MAX} onChange={e => setName(e.target.value)} placeholder="e.g. Grill" className={INPUT} autoFocus={!station} />
        </label>
        <fieldset className="border-0 m-0 p-0 flex flex-col gap-2">
          <legend className={`${FIELD_LABEL} p-0 mb-2`}>COLOUR</legend>
          <div className="flex flex-wrap gap-1.5">
            {STATION_COLORS.map(c => (
              <button
                key={c}
                type="button"
                aria-pressed={color === c}
                aria-label={COLOR_NAMES[c]}
                onClick={() => setColor(c)}
                className={`w-11 h-11 rounded-full grid place-items-center ${color === c ? 'ring-2 ring-ink ring-offset-2' : ''}`}
                style={{ background: c }}
              >
                {color === c && <Check size={18} strokeWidth={3} className="text-white" aria-hidden />}
              </button>
            ))}
          </div>
        </fieldset>
        <SheetError error={error} />
        {confirm && station ? (
          <ConfirmRemove text={`Remove ${station.name}? Its history stays.`} busy={busy} onKeep={() => setConfirm(false)} onRemove={remove} />
        ) : (
          <div className="flex gap-2">
            {station && (
              <button type="button" onClick={() => setConfirm(true)} className="flex-none min-h-[50px] px-4 rounded-xl border border-line-2 bg-paper text-[14px] font-medium text-red-text">
                Remove
              </button>
            )}
            <button type="submit" disabled={busy} className="flex-1 min-h-[50px] rounded-xl bg-ink text-paper text-[14px] font-medium disabled:opacity-50">
              {station ? 'Save station' : 'Add station'} <span className="text-gold">✓</span>
            </button>
          </div>
        )}
      </form>
    </Sheet>
  )
}

/** New category, or rename / remove one. */
export function CategorySheet({
  category,
  meta,
  onClose,
  onSave,
  onRemove,
}: {
  category: CategoryTree | null
  /** "GRILL · OPENING" */
  meta: string
  onClose: () => void
  onSave: (name: string) => Promise<string | null>
  onRemove: () => Promise<string | null>
}) {
  const [name, setName] = useState(category?.name ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    const err = await onSave(name)
    setBusy(false)
    if (err) setError(err)
    else onClose()
  }
  const remove = async () => {
    if (busy) return
    setBusy(true)
    const err = await onRemove()
    setBusy(false)
    if (err) { setError(err); setConfirm(false) } else onClose()
  }

  const n = category?.items.length ?? 0
  return (
    <Sheet label={category ? 'Edit category' : 'New category'} onClose={onClose}>
      <form onSubmit={save} className="flex flex-col gap-[18px]">
        <SheetHeader title={category ? 'Edit category' : 'New category'} meta={meta} />
        <label className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL}>NAME</span>
          <input type="text" value={name} maxLength={NAME_MAX} onChange={e => setName(e.target.value)} placeholder="e.g. Equipment" className={INPUT} autoFocus={!category} />
        </label>
        <SheetError error={error} />
        {confirm && category ? (
          <ConfirmRemove
            text={n > 0 ? `Remove ${category.name} and its ${n} ${n === 1 ? 'job' : 'jobs'}? Its history stays.` : `Remove ${category.name}? Its history stays.`}
            busy={busy}
            onKeep={() => setConfirm(false)}
            onRemove={remove}
          />
        ) : (
          <div className="flex gap-2">
            {category && (
              <button type="button" onClick={() => setConfirm(true)} className="flex-none min-h-[50px] px-4 rounded-xl border border-line-2 bg-paper text-[14px] font-medium text-red-text">
                Remove
              </button>
            )}
            <button type="submit" disabled={busy} className="flex-1 min-h-[50px] rounded-xl bg-ink text-paper text-[14px] font-medium disabled:opacity-50">
              {category ? 'Save category' : 'Add category'} <span className="text-gold">✓</span>
            </button>
          </div>
        )}
      </form>
    </Sheet>
  )
}

/** Pick a station whose list (this phase) is appended onto the current one. */
export function CopySheet({
  target,
  stations,
  phase,
  onClose,
  onCopy,
}: {
  target: EditStation
  stations: EditStation[]
  phase: Phase
  onClose: () => void
  onCopy: (fromId: string) => Promise<string | null>
}) {
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const word = phase === 'OPEN' ? 'opening' : 'closing'
  const sources = stations.filter(s => s.id !== target.id)

  const pick = async (id: string) => {
    if (busyId) return
    setBusyId(id)
    const err = await onCopy(id)
    setBusyId(null)
    if (err) setError(err)
    else onClose()
  }

  return (
    <Sheet label="Copy from another station" onClose={onClose}>
      <div className="flex flex-col gap-1.5">
        <SheetHeader title="Copy from…" />
        <p className="m-0 text-[14px] leading-[1.45] text-ink-3">
          Adds that station’s {word} list to the end of {target.name}’s. Nothing here is replaced.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        {sources.map(s => {
          const n = phaseCount(s, phase)
          return (
            <button
              key={s.id}
              type="button"
              disabled={n === 0 || !!busyId}
              onClick={() => pick(s.id)}
              className="flex items-center gap-3 min-h-[56px] px-3.5 py-2 rounded-xl border border-line bg-paper text-left disabled:opacity-50"
            >
              <span className="flex-none w-2.5 h-2.5 rounded-full" style={{ background: s.color }} aria-hidden />
              <span className="flex-1 min-w-0 text-[15px] font-semibold tracking-[-0.015em] text-ink">{chipName(s)}</span>
              <span className="flex-none font-mono text-[10.5px] text-ink-3">
                {busyId === s.id ? 'COPYING…' : `${n} ${n === 1 ? 'JOB' : 'JOBS'}`}
              </span>
            </button>
          )
        })}
      </div>
      <SheetError error={error} />
    </Sheet>
  )
}
