'use client'
import { useState } from 'react'
import { parseItemInput, TITLE_MAX, HOW_TO_MAX, type Answer, type ItemData } from '@/lib/checklists/item-input'
import {
  ALL_DAYS, DAY_LETTERS, DAY_NAMES, daysToToggles, togglesToDays,
  type CategoryTree, type EditItem, type EditTempUnit,
} from '@/lib/checklists/edit-format'
import type { Phase } from '@/lib/checklists/rules'
import { rangeText } from '@/components/checklists/LineRow'
import { ConfirmRemove, FIELD_LABEL, INPUT, Sheet, SheetError, SheetHeader } from './EditSheets'

// "Edit item" — one job on a station's opening or closing list. On a phone it is
// a bottom sheet (ItemSheet); on a computer the same form sits in the builder's
// side panel (ItemForm, variant 'panel'). The same rules as the server
// (parseItemInput) run before it sends.

const ANSWERS: { key: Answer; label: string }[] = [
  { key: 'TICK', label: 'A tick' },
  { key: 'NUMBER', label: 'A number' },
  { key: 'TEMP', label: 'A temperature' },
]

const SMALL_LABEL = 'font-mono text-[10px] text-ink-3'
const SMALL_INPUT = 'h-11 border border-line-2 rounded-[9px] px-2.5 font-mono text-[14px] text-ink bg-paper w-full min-w-0'

const asText = (n: number | null | undefined) => (n == null ? '' : String(n))

export type ListChoice = { id: string; name: string; color: string }

type ItemFormProps = {
  /** null = a new job. */
  item: EditItem | null
  /** The category the job is in, or the one "+ Add item" was tapped on. */
  categoryId: string
  /** This station's categories for this phase. */
  categories: CategoryTree[]
  tempUnits: EditTempUnit[]
  phase: Phase
  /** "GRILL · OPENING" */
  meta: string
  onClose: () => void
  /** Resolves to the server's message, or null when saved. */
  onSave: (data: ItemData) => Promise<string | null>
  onRemove: () => Promise<string | null>
  /** Every list in this kitchen, in builder order. */
  stations: ListChoice[]
  /** The station this copy is on. */
  ownStationId: string
  /** The station ids this job sits on (own first). */
  lists: string[]
  /** Puts the job on exactly these lists. Resolves to the server's message, or null. */
  onLists: (stationIds: string[]) => Promise<string | null>
  /** Prefill for a new job (from the quick-add box). */
  draftTitle?: string
}

export function ItemSheet(props: ItemFormProps) {
  return (
    <Sheet label={props.item ? 'Edit item' : 'New item'} onClose={props.onClose}>
      <ItemForm {...props} variant="sheet" />
    </Sheet>
  )
}

export function ItemForm({
  item,
  categoryId,
  categories,
  tempUnits,
  phase,
  meta,
  onClose,
  onSave,
  onRemove,
  stations,
  ownStationId,
  lists,
  onLists,
  draftTitle,
  variant,
}: ItemFormProps & { variant: 'sheet' | 'panel' }) {
  const [title, setTitle] = useState(item?.title ?? draftTitle ?? '')
  const [howTo, setHowTo] = useState(item?.howTo ?? '')
  const [isBlocker, setIsBlocker] = useState(item?.isBlocker ?? false)
  const [answer, setAnswer] = useState<Answer>(item?.answer ?? 'TICK')
  const [unit, setUnit] = useState(item?.answer === 'NUMBER' ? item.unit ?? '' : '')
  const [safeMin, setSafeMin] = useState(item?.answer === 'NUMBER' ? asText(item.safeMin) : '')
  const [safeMax, setSafeMax] = useState(item?.answer === 'NUMBER' ? asText(item.safeMax) : '')
  const [tempUnitId, setTempUnitId] = useState(item?.tempUnitId ?? '')
  const [days, setDays] = useState<boolean[]>(() => daysToToggles(item?.days ?? ALL_DAYS))
  const [dueBy, setDueBy] = useState(item?.dueBy ?? '')
  const [catId, setCatId] = useState(categoryId)
  const [listsBusy, setListsBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)

  const temp = tempUnits.find(u => u.id === tempUnitId) ?? null
  const tempRange = temp ? rangeText(temp.safeMin, temp.safeMax, '°C') : ''

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    const parsed = parseItemInput({
      title, howTo, isBlocker, answer, unit, safeMin, safeMax,
      tempUnitId: tempUnitId || null, days: togglesToDays(days), dueBy, categoryId: catId,
    })
    if (!parsed.ok) { setError(parsed.error); return }
    setError(null)
    setBusy(true)
    const err = await onSave(parsed.data)
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

  const toggleDay = (i: number) => setDays(prev => prev.map((on, j) => (j === i ? !on : on)))

  const toggleList = async (stationId: string) => {
    if (listsBusy || stationId === ownStationId) return
    const next = lists.includes(stationId) ? lists.filter(id => id !== stationId) : [...lists, stationId]
    setListsBusy(true)
    const err = await onLists(next)
    setListsBusy(false)
    setError(err)
  }

  const shared = lists.length > 1
  const ownName = stations.find(s => s.id === ownStationId)?.name ?? 'this list'

  return (
    <form onSubmit={save} aria-label={item ? 'Edit item' : 'New item'} className="flex flex-col gap-[18px]">
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0"><SheetHeader title={item ? 'Edit item' : 'New item'} meta={meta} /></div>
          {variant === 'panel' && (
            <button type="button" onClick={onClose} aria-label="Close" className="flex-none -mr-2 -mt-2 w-11 h-11 grid place-items-center text-ink-3 text-[20px]">×</button>
          )}
        </div>

        <label className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL}>WHAT TO DO</span>
          <input type="text" value={title} maxLength={TITLE_MAX} onChange={e => setTitle(e.target.value)} placeholder="e.g. Lowboy temp" className={INPUT} autoFocus={!item} />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL}>HOW (OPTIONAL · SHOWN TO THE COOK)</span>
          <textarea
            rows={2}
            value={howTo}
            maxLength={HOW_TO_MAX}
            onChange={e => setHowTo(e.target.value)}
            placeholder="e.g. Probe the middle shelf, not the door."
            className="border border-line-2 rounded-[9px] px-3 py-2.5 text-[14px] leading-[1.45] text-ink bg-paper resize-none"
          />
        </label>

        <div className="flex items-center gap-3 border border-line rounded-xl px-3.5 py-3">
          <span className="flex-1 flex flex-col gap-0.5">
            <span className="text-[14.5px] font-semibold">Blocker</span>
            <span className="text-[12.5px] text-ink-3">
              {phase === 'OPEN' ? 'Must be done (or flagged) before doors open' : 'Must be done (or flagged) before you sign off'}
            </span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={isBlocker}
            aria-label="Blocker"
            onClick={() => setIsBlocker(v => !v)}
            className={`flex-none relative w-[52px] h-8 rounded-full p-0 ${isBlocker ? 'bg-green' : 'bg-line-2'}`}
          >
            <span className={`absolute top-[3px] w-[26px] h-[26px] rounded-full bg-paper transition-[left] ${isBlocker ? 'left-[23px]' : 'left-[3px]'}`} />
          </button>
        </div>

        <fieldset className="border-0 m-0 p-0 flex flex-col gap-2">
          <legend className={`${FIELD_LABEL} p-0 mb-2`}>THE COOK ANSWERS WITH</legend>
          <div className="grid grid-cols-3 gap-1.5">
            {ANSWERS.map(a => (
              <button
                key={a.key}
                type="button"
                aria-pressed={answer === a.key}
                onClick={() => setAnswer(a.key)}
                className={`min-h-[44px] rounded-[9px] text-[13px] ${answer === a.key ? 'border-[1.5px] border-ink bg-ink text-paper font-medium' : 'border border-line-2 bg-paper text-ink-2'}`}
              >
                {a.label}
              </button>
            ))}
          </div>

          {answer === 'NUMBER' && (
            <>
              <div className="grid grid-cols-3 gap-1.5">
                <label className="flex flex-col gap-1">
                  <span className={SMALL_LABEL}>UNIT</span>
                  <input type="text" value={unit} maxLength={12} onChange={e => setUnit(e.target.value)} placeholder="°C" className={SMALL_INPUT} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className={SMALL_LABEL}>SAFE FROM</span>
                  {/* Plain text keyboard: freezer ranges need a minus, which the decimal pad lacks. */}
                  <input type="text" value={safeMin} onChange={e => setSafeMin(e.target.value)} placeholder="—" className={SMALL_INPUT} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className={SMALL_LABEL}>TO</span>
                  <input type="text" value={safeMax} onChange={e => setSafeMax(e.target.value)} placeholder="—" className={SMALL_INPUT} />
                </label>
              </div>
              <span className="text-[12.5px] text-ink-3">Out of range flags it to you automatically. Leave a side empty for no limit.</span>
            </>
          )}

          {answer === 'TEMP' && (
            <>
              <label className="flex flex-col gap-1">
                <span className={SMALL_LABEL}>FRIDGE OR UNIT (FROM TEMPS)</span>
                <select value={tempUnitId} onChange={e => setTempUnitId(e.target.value)} className={INPUT}>
                  <option value="">Pick a fridge or unit…</option>
                  {tempUnits.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </label>
              {temp && (
                <span className="text-[12.5px] text-ink-3">
                  {tempRange
                    ? <>Safe <b className="font-mono font-medium text-ink-2">{tempRange}</b>, set in Temps. Out of range flags it to you automatically.</>
                    : 'No safe range is set for this unit in Temps.'}
                </span>
              )}
              {tempUnits.length === 0 && <span className="text-[12.5px] text-ink-3">No fridges or units are set up in Temps for this kitchen yet.</span>}
            </>
          )}
        </fieldset>

        <fieldset className="border-0 m-0 p-0 flex flex-col gap-2">
          <legend className={`${FIELD_LABEL} p-0 mb-2`}>WHICH DAYS</legend>
          <div className="grid grid-cols-7 gap-1">
            {DAY_LETTERS.map((d, i) => (
              <button
                key={i}
                type="button"
                aria-pressed={days[i]}
                aria-label={DAY_NAMES[i]}
                onClick={() => toggleDay(i)}
                className={`min-h-[44px] rounded-[9px] font-mono text-[11px] font-medium ${days[i] ? 'border-[1.5px] border-ink bg-ink text-paper' : 'border border-line-2 bg-paper text-ink-3'}`}
              >
                {d}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL}>DUE BY (OPTIONAL)</span>
          <span className="flex items-center gap-2">
            <input
              type="time"
              value={dueBy}
              onChange={e => setDueBy(e.target.value)}
              aria-label="Due by"
              className={`${SMALL_INPUT} max-w-[150px]`}
            />
            {dueBy && (
              <button type="button" onClick={() => setDueBy('')} className="min-h-[44px] px-2 font-mono text-[11px] text-ink-3">
                No time
              </button>
            )}
          </span>
          <span className="text-[12.5px] text-ink-3">The cook sees “by {dueBy ? dueBy.replace(/^0/, '') : '8:45'}”; it turns red when it’s late.</span>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL}>CATEGORY</span>
          <select value={catId} onChange={e => setCatId(e.target.value)} className={INPUT}>
            {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>

        <fieldset className="border-0 m-0 p-0 flex flex-col gap-2">
          <legend className={`${FIELD_LABEL} p-0 mb-2`}>ON THESE LISTS</legend>
          {item ? (
            <>
              <div className="flex gap-1.5 flex-wrap" aria-busy={listsBusy || undefined}>
                {stations.map(s => {
                  const on = lists.includes(s.id)
                  const own = s.id === ownStationId
                  return (
                    <button
                      key={s.id}
                      type="button"
                      aria-pressed={on}
                      disabled={own || listsBusy}
                      onClick={() => toggleList(s.id)}
                      className={`min-h-[40px] px-3 rounded-full text-[13px] flex items-center gap-1.5 disabled:cursor-default ${on ? 'bg-ink text-paper font-medium' : 'border border-line-2 bg-paper text-ink-2'} ${listsBusy && !own ? 'opacity-60' : ''}`}
                    >
                      <span className="w-2 h-2 rounded-full flex-none" style={{ background: s.color }} aria-hidden />
                      {s.name}{on && ' ✓'}
                    </button>
                  )
                })}
              </div>
              <span className="text-[12.5px] text-ink-3">
                {shared
                  ? `One job on ${lists.length} lists. Whoever does it first ticks it off on all of them, and saving changes it on all ${lists.length}. Tapping a list saves straight away.`
                  : 'Tap another list to put this same job there too: done once, ticked off on every list. Saves straight away.'}
              </span>
            </>
          ) : (
            <span className="text-[12.5px] text-ink-3">Save it first, then you can put it on other lists.</span>
          )}
        </fieldset>

        <SheetError error={error} />

        {confirm && item ? (
          <ConfirmRemove text={shared ? `Take ${item.title} off ${ownName}? The other lists keep it.` : `Remove ${item.title}? Its history stays.`} busy={busy} onKeep={() => setConfirm(false)} onRemove={remove} />
        ) : (
          <div className="flex gap-2">
            {item && (
              <button type="button" onClick={() => setConfirm(true)} className="flex-none min-h-[50px] px-4 rounded-xl border border-line-2 bg-paper text-[14px] font-medium text-red-text">
                {shared ? `Off ${ownName}` : 'Remove'}
              </button>
            )}
            <button type="submit" disabled={busy} className="flex-1 min-h-[50px] rounded-xl bg-ink text-paper text-[14px] font-medium disabled:opacity-50">
              {shared ? `Save on ${lists.length} lists` : 'Save item'} <span className="text-gold">✓</span>
            </button>
          </div>
        )}
    </form>
  )
}
