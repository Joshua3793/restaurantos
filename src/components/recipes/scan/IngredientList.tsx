'use client'
// Recipe Scan — the scanned ingredients (design: IngredientMatchRow), in the
// order the page wrote them. Each row: index, what it matched (or the raw
// words), a pill, `read as "…"` (always — the chef checks the machine against
// the page), the line cost or why there is none (never a silent $0), and ONE
// call to action. Tapping a row opens its details (amount, what it's linked
// to); an unlinked line always shows its allergen choice.
import { useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { Pill } from '@/components/ui/Pill'
import { UOM_GROUPS, getUnitGroup } from '@/lib/uom'
import { unitFitsItem } from '@/lib/recipe-scan/amount'
import type { DraftData, DraftLine } from '@/lib/recipe-scan/types'
import {
  applyPick, keepUncosted, confirmLine, canConfirm, unitMisfit, setLineAmount, setQtyText, setAllergens, needsYou, linkKey,
  type LineCosts, type LinkInfo, type PickCandidate,
} from '@/lib/recipe-scan/review'
import { AllergenChoice } from './AllergenChoice'
import { IngredientPicker } from './IngredientPicker'
import type { CreatedItem } from './CreateItemForm'

interface Props {
  data: DraftData
  costs: LineCosts
  links: Record<string, LinkInfo>
  categoryColor: (name: string) => string | null
  isDesktop: boolean
  revenueCenterId: string | null
  onChange: (next: DraftData) => void
  onLink: (key: string, info: LinkInfo) => void
}

const money = (n: number) => `$${n.toFixed(2)}`
const fmtQty = (n: number) => String(Number(n.toFixed(3)))
const pad = (i: number) => String(i + 1).padStart(2, '0')

/** The row's pill: Matched / Check / No match / Prep · category / No amount / Uncosted. */
export function LinePill({ line, info, categoryColor }: {
  line: DraftLine
  info: LinkInfo | null
  categoryColor: (name: string) => string | null
}) {
  if (!line.link) {
    return line.allergens === null ? <Pill tone="alert">No match</Pill> : <Pill>Uncosted</Pill>
  }
  if (line.status === 'CHECK') return <Pill tone="gold">Check</Pill>
  if (line.status === 'NO_AMOUNT') return <Pill>No amount</Pill>
  if (line.link.kind === 'recipe') {
    const cat = info?.boughtAs?.replace(/^PREP\s*·\s*/i, '').trim() || ''
    return (
      <Pill>
        <span className="w-[6px] h-[6px] rounded-full" style={{ background: (cat && categoryColor(cat)) || '#94a3b8' }} />
        Prep{cat ? ` · ${cat}` : ''}
      </Pill>
    )
  }
  return <Pill tone="ok">Matched</Pill>
}

function CostCell({ line, cost }: { line: DraftLine; cost: LineCosts[string] | undefined }) {
  const amount = line.link && typeof line.qty === 'number' && line.qty > 0 && line.unit
    ? `${fmtQty(line.qty)} ${line.unit}`
    : line.link ? '' : line.qtyText
  let main: ReactNode = '—'
  let sub: ReactNode = 'not costed'
  let tone = 'text-red-text'
  if (!line.link) {
    tone = line.allergens === null ? 'text-red-text' : 'text-ink-3'
  } else if (line.status === 'NO_AMOUNT' || line.qty === 0) {
    sub = 'no amount'; tone = 'text-ink-3'
  } else if (!cost) {
    main = '…'; sub = amount; tone = 'text-ink-3'
  } else if (cost.unpriced) {
    sub = 'no price yet'; tone = 'text-ink-3'
  } else if (cost.lineCost === null) {
    sub = line.qty ? `can't cost in ${line.unit}` : 'not costed'
    tone = line.status === 'CHECK' ? 'text-gold-2' : 'text-red-text'
  } else {
    main = money(cost.lineCost); sub = amount
    tone = line.status === 'CHECK' ? 'text-gold-2' : 'text-ink'
  }
  return (
    <div className={`font-mono text-[12.5px] font-semibold text-right tracking-[-0.01em] ${tone}`}>
      {main}
      <small className="block font-normal text-[10px] text-ink-3 mt-0.5 whitespace-nowrap">{sub}</small>
    </div>
  )
}

function CtaButton({ kind, label, onClick }: { kind: 'gold' | 'ink' | 'out'; label: string; onClick: () => void }) {
  const tone = kind === 'gold'
    ? 'bg-gold border-gold text-ink hover:opacity-90'
    : kind === 'ink'
      ? 'bg-ink border-ink text-paper hover:bg-ink-2'
      : 'bg-paper border-line text-ink-2 hover:border-ink-3'
  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); onClick() }}
      className={`font-mono text-[11px] font-medium px-[13px] py-[7px] rounded-full border whitespace-nowrap ${tone}`}
    >
      {label}
    </button>
  )
}

function AmountEditor({ line, info, onAmount }: {
  line: DraftLine
  info: LinkInfo | null
  onAmount: (qty: number | null, unit: string | null) => void
}) {
  const unit = line.unit || info?.baseUnit || ''
  const itemGroup = info?.baseUnit ? getUnitGroup(info.baseUnit) : null
  const item = info?.amount ?? null
  // Only the units that fit how the item is bought (Joshua's rule: amounts go
  // into the item's own unit) — no "cup" for flour bought by weight.
  const groups = [...UOM_GROUPS]
    .map(g => (item ? { ...g, units: g.units.filter(u => unitFitsItem(u.label, item)) } : g))
    .filter(g => g.units.length > 0)
    .sort((a, b) => (a.label === itemGroup ? -1 : b.label === itemGroup ? 1 : 0))
  const known = groups.some(g => g.units.some(u => u.label === unit))
  return (
    <div className="flex items-center gap-1.5">
      <input
        key={`${line.key}:${line.qty}:${line.unit}`}
        type="number" min={0} step="any" inputMode="decimal"
        defaultValue={typeof line.qty === 'number' && line.qty > 0 ? line.qty : ''}
        placeholder="amount"
        aria-label="Amount"
        onBlur={e => {
          const v = e.target.value.trim()
          const n = v === '' ? null : Number(v)
          const next = n !== null && Number.isFinite(n) && n > 0 ? n : null
          const cur = typeof line.qty === 'number' && line.qty > 0 ? line.qty : null
          if (next !== cur) onAmount(next, unit || null)
        }}
        className={`w-[90px] font-mono text-[13px] text-right bg-paper border rounded-[7px] px-2 py-1 outline-none focus:border-ink-3 ${
          line.status === 'CHECK' && !(typeof line.qty === 'number' && line.qty > 0) ? 'border-gold' : 'border-line'
        }`}
      />
      <select
        aria-label="Unit"
        value={unit}
        onChange={e => onAmount(typeof line.qty === 'number' && line.qty > 0 ? line.qty : null, e.target.value)}
        className="font-mono text-[12.5px] bg-paper border border-line rounded-[7px] px-1.5 py-1 outline-none focus:border-ink-3"
      >
        {!unit && <option value="">unit</option>}
        {unit && !known && <option value={unit}>{unit}</option>}
        {groups.map(g => (
          <optgroup key={g.label} label={g.label}>
            {g.units.map(u => <option key={u.label} value={u.label}>{u.label}</option>)}
          </optgroup>
        ))}
      </select>
    </div>
  )
}

function KV({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="px-3.5 py-2.5 border-b md:border-b-0 md:border-r border-line last:border-0 min-w-0">
      <div className="font-mono text-[9.5px] uppercase tracking-[0.04em] text-ink-3">{k}</div>
      <div className="text-[13px] font-medium text-ink mt-1 leading-snug break-words">{children}</div>
    </div>
  )
}

interface RowProps {
  line: DraftLine
  index: number
  cost: LineCosts[string] | undefined
  info: LinkInfo | null
  firstNoMatch: boolean
  sibling: string | null
  expanded: boolean
  needAmount: boolean
  categoryColor: (name: string) => string | null
  picker: ReactNode
  onToggle: () => void
  onCta: () => void
  onPickOpen: () => void
  onKeep: () => void
  onConfirm: () => void
  onAmount: (qty: number | null, unit: string | null) => void
  onQtyText: (t: string) => void
  onAllergens: (a: string[] | null) => void
}

function IngredientRow(p: RowProps) {
  const { line } = p
  const linked = !!line.link
  const undecided = !linked && line.allergens === null
  const cta: { kind: 'gold' | 'ink' | 'out'; label: string } =
    undecided ? { kind: p.firstNoMatch ? 'gold' : 'out', label: 'Pick item' }
    : line.status === 'CHECK' ? { kind: 'ink', label: 'Confirm' }
    : { kind: 'out', label: 'Change' }
  const title = linked ? line.link!.name : line.raw

  return (
    <div id={`line-${line.key}`} className={`border-b border-line last:border-b-0 transition-colors ${p.expanded ? 'bg-[#fcfcfb]' : 'hover:bg-[#fcfcfb]'}`}>
      <div
        role="button"
        tabIndex={0}
        onClick={p.onToggle}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onToggle() } }}
        className="grid grid-cols-[22px_minmax(0,1fr)_auto] md:grid-cols-[26px_minmax(0,1fr)_104px_auto] gap-x-3 md:gap-x-4 items-center px-3 md:px-4 py-3 cursor-pointer"
      >
        <span className="font-mono text-[11.5px] text-ink-4 self-start pt-[2px]">{pad(p.index)}</span>
        <div className="min-w-0">
          <div className="text-[14.5px] font-semibold tracking-[-0.015em] leading-[1.3] text-ink flex items-center gap-1.5">
            <span className="min-w-0 break-words">{title}</span>
            <ChevronDown size={13} className={`shrink-0 text-ink-4 transition-transform ${p.expanded ? 'rotate-180' : ''}`} />
          </div>
          <div className="font-mono text-[10.5px] text-ink-3 mt-[5px] flex gap-x-2 gap-y-1 items-center flex-wrap">
            <LinePill line={line} info={p.info} categoryColor={p.categoryColor} />
            {line.createdItem && <span className="text-ink-2">new item</span>}
            {line.reason && <span className="text-gold-2">{line.reason}</span>}
            <span>read as <q className="text-ink-2">{line.raw}</q></span>
          </div>
          {p.sibling && (
            <p className="text-[12px] text-ink-3 mt-1">{p.sibling} is in this scan — save it first</p>
          )}
        </div>
        <div className="hidden md:block"><CostCell line={line} cost={p.cost} /></div>
        <div className="flex flex-col items-end gap-1.5">
          <div className="md:hidden"><CostCell line={line} cost={p.cost} /></div>
          <CtaButton kind={cta.kind} label={cta.label} onClick={p.onCta} />
        </div>
      </div>

      {p.expanded && (
        <div className="px-3 md:pl-[58px] md:pr-4 pb-3">
          <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] border border-line rounded-[10px] bg-paper">
            <KV k="Read as">{line.raw}</KV>
            <KV k={linked ? 'Amount' : 'Amount as written'}>
              {linked ? (
                <AmountEditor line={line} info={p.info} onAmount={p.onAmount} />
              ) : (
                <input
                  key={`${line.key}:${line.qtyText}`}
                  defaultValue={line.qtyText}
                  aria-label="Amount as written"
                  onBlur={e => { if (e.target.value !== line.qtyText) p.onQtyText(e.target.value) }}
                  className="w-full font-mono text-[13px] bg-paper border border-line rounded-[7px] px-2 py-1 outline-none focus:border-ink-3"
                />
              )}
            </KV>
            <KV k="Linked to">
              {linked ? (
                <>
                  {line.link!.name}
                  {p.info && (
                    <span className="block font-mono text-[10.5px] text-ink-3 mt-0.5 uppercase">
                      {[p.info.boughtAs, p.info.supplier].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </>
              ) : <span className="text-ink-3">Nothing — not costed</span>}
            </KV>
          </div>
          {line.status === 'CHECK' && unitMisfit(line, p.info?.amount) ? (
            <p className="text-[12.5px] text-gold-2 mt-2">{line.unit} doesn&apos;t fit how this is bought — pick a {p.info?.baseUnit ?? 'fitting'} amount.</p>
          ) : p.needAmount && line.status === 'CHECK' && !canConfirm(line, p.info?.amount) && (
            <p className="text-[12.5px] text-gold-2 mt-2">Add the amount, then confirm.</p>
          )}
          <div className="flex gap-2 mt-2.5 flex-wrap">
            {line.status === 'CHECK' && canConfirm(line, p.info?.amount) && <CtaButton kind="ink" label="Confirm" onClick={p.onConfirm} />}
            <CtaButton kind="out" label={linked ? 'Pick another' : 'Pick item'} onClick={p.onPickOpen} />
            {linked && <CtaButton kind="out" label="Keep uncosted" onClick={p.onKeep} />}
          </div>
        </div>
      )}

      {p.picker}

      {!linked && (
        <div className="px-3 md:pl-[58px] md:pr-4 pb-3" onClick={e => e.stopPropagation()}>
          <AllergenChoice value={line.allergens} onChange={p.onAllergens} />
        </div>
      )}
    </div>
  )
}

export function IngredientList({ data, costs, links, categoryColor, isDesktop, revenueCenterId, onChange, onLink }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const [pickerKey, setPickerKey] = useState<string | null>(null)
  const [needAmount, setNeedAmount] = useState<string | null>(null)

  const firstNoMatch = data.lines.find(l => !l.link && l.allergens === null)?.key ?? null
  const needYou = data.lines.filter(needsYou).length
  const infoOf = (l: DraftLine) => (l.link ? links[linkKey(l.link)] ?? null : null)

  const closePicker = () => setPickerKey(null)
  const pick = (key: string, c: PickCandidate) => {
    onLink(linkKey(c), { baseUnit: c.baseUnit, boughtAs: c.boughtAs, supplier: c.supplier, amount: c.amount })
    onChange(applyPick(data, key, c))
    closePicker()
    setExpanded(key)
  }
  const created = (key: string, item: CreatedItem) => {
    onLink(linkKey({ kind: 'item', id: item.id }), {
      baseUnit: item.baseUnit, boughtAs: `New item · by the ${item.unit}`, supplier: null, amount: item.amount,
    })
    onChange(applyPick(data, key, { kind: 'item', id: item.id, name: item.name, amount: item.amount }, { createdItem: true }))
    closePicker()
    setExpanded(key)
  }
  const keep = (key: string) => {
    onChange(keepUncosted(data, key))
    closePicker()
  }

  const pickerFor = (l: DraftLine, mode: 'sheet' | 'inline') => (
    <IngredientPicker
      key={`${l.key}:${mode}`}
      line={l}
      mode={mode}
      revenueCenterId={revenueCenterId}
      pill={<LinePill line={l} info={infoOf(l)} categoryColor={categoryColor} />}
      onPick={c => pick(l.key, c)}
      onCreated={item => created(l.key, item)}
      onKeep={() => keep(l.key)}
      onClose={closePicker}
    />
  )

  const sheetLine = !isDesktop && pickerKey ? data.lines.find(l => l.key === pickerKey) ?? null : null

  return (
    <section className="bg-paper border border-line rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 md:px-4 py-[13px] border-b border-line">
        <h3 className="text-[13.5px] font-semibold tracking-[-0.01em] text-ink flex items-baseline gap-2">
          Ingredients
          <span className="font-mono text-[10.5px] text-ink-3 font-normal">
            · {data.lines.length} read{needYou > 0 && <> · <span className="text-red-text">{needYou} need you</span></>}
          </span>
        </h3>
        <span className="font-mono text-[10.5px] text-ink-3 uppercase tracking-[0.03em]">in page order</span>
      </div>
      {data.lines.length === 0 && (
        <p className="px-4 py-5 text-[13px] text-ink-3">No ingredients were read from the page.</p>
      )}
      {data.lines.map((l, i) => (
        <IngredientRow
          key={l.key}
          line={l}
          index={i}
          cost={costs[l.key]}
          info={infoOf(l)}
          firstNoMatch={l.key === firstNoMatch}
          sibling={data.siblingHints?.[l.key] ?? null}
          expanded={expanded === l.key}
          needAmount={needAmount === l.key}
          categoryColor={categoryColor}
          picker={isDesktop && pickerKey === l.key ? pickerFor(l, 'inline') : null}
          onToggle={() => { setExpanded(e => (e === l.key ? null : l.key)); setNeedAmount(null) }}
          onCta={() => {
            if (l.status === 'CHECK' && l.link) {
              if (canConfirm(l, infoOf(l)?.amount)) onChange(confirmLine(data, l.key, infoOf(l)?.amount))
              else { setExpanded(l.key); setNeedAmount(l.key) }
              return
            }
            setExpanded(null)
            setPickerKey(k => (k === l.key ? null : l.key))
          }}
          onPickOpen={() => { setExpanded(null); setPickerKey(l.key) }}
          onKeep={() => keep(l.key)}
          onConfirm={() => onChange(confirmLine(data, l.key, infoOf(l)?.amount))}
          onAmount={(q, u) => onChange(setLineAmount(data, l.key, q, u, infoOf(l)?.amount))}
          onQtyText={t => onChange(setQtyText(data, l.key, t))}
          onAllergens={a => onChange(setAllergens(data, l.key, a))}
        />
      ))}
      {sheetLine && pickerFor(sheetLine, 'sheet')}
    </section>
  )
}
