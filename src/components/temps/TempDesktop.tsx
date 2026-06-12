'use client'
import { useState } from 'react'
import {
  Plus, X, Trash2, Clock, Download, Thermometer, Snowflake, Flame,
} from 'lucide-react'
import {
  TEMP_TYPES, TEMP_GROUPS, groupOf, isSafe, rangeText, unitStatus, fmtTemp, nowHM, prettyDate,
  type TempUnit, type TempType, type TempHandlers, type TempDayMetrics,
  type HistoryReading, type TempGroupKey,
} from './temp-utils'
import { TempEquipmentView } from './TempEquipmentView'

const RING_C = 2 * Math.PI * 44 // 276.46

const GROUP_ICON: Record<TempGroupKey, React.ReactNode> = {
  cold: <Thermometer size={15} />,
  frz: <Snowflake size={15} />,
  hot: <Flame size={15} />,
}
const GROUP_ICON_CLASS: Record<TempGroupKey, string> = {
  cold: 'bg-blue-soft text-blue-text',
  frz: 'bg-[#ede9fe] text-[#6d28d9]',
  hot: 'bg-gold-soft text-gold-2',
}

export interface TempDesktopProps {
  units: TempUnit[]
  metrics: TempDayMetrics
  handlers: TempHandlers
  today: string
  view: 'today' | 'history'
  setView: (v: 'today' | 'history') => void
  addOpen: boolean
  setAddOpen: (b: boolean) => void
  rcLabel: string
  history: HistoryReading[]
  histLoading: boolean
  histUnit: string
  setHistUnit: (v: string) => void
  histRange: string
  setHistRange: (v: string) => void
  histView: 'day' | 'equipment'
  setHistView: (v: 'day' | 'equipment') => void
  onExport: () => void
  histDays: number
}

export function TempDesktop(p: TempDesktopProps) {
  const { units, metrics, handlers, view, setView } = p
  const m = metrics
  const ringColor = m.flagged ? '#dc2626' : m.allClear ? '#16a34a' : '#d97706'

  return (
    <div className="hidden md:block">
      {/* status chrome strip */}
      <div className="bg-ink text-paper rounded-xl px-5 py-2.5 flex items-center gap-6 mb-4 -mt-1">
        <ChromeItem label="Today" value={prettyDate(p.today)} />
        <span className="w-px h-3.5 bg-ink-2" />
        <ChromeItem label="Logged" value={`${m.logged} / ${m.total}`} />
        <span className="w-px h-3.5 bg-ink-2" />
        <ChromeItem label="Out of range" value={String(m.flagged)} tone={m.flagged ? 'bad' : 'ok'} />
        <span className="flex-1" />
        <span className="font-mono text-[10.5px] text-ink-3">
          readings auto-timestamp to the food-safety record · HACCP critical limits
        </span>
      </div>

      {/* view tabs */}
      <div className="flex items-stretch border-b border-line mb-5">
        <Tab active={view === 'today'} onClick={() => setView('today')} icon={<Thermometer size={14} />}>
          Today&apos;s log
        </Tab>
        <Tab active={view === 'history'} onClick={() => setView('history')} icon={<Clock size={14} />}>
          History <span className="font-mono text-[10px] text-ink-4 ml-1">{p.histDays} day{p.histDays === 1 ? '' : 's'}</span>
        </Tab>
      </div>

      {/* header */}
      <div className="flex justify-between items-center gap-6 mb-5">
        <div>
          <h1 className="text-[32px] font-semibold tracking-[-0.035em] leading-[1.05] m-0">
            Temp <span className="text-gold-2">charts</span>.
          </h1>
          <p className="text-[13.5px] text-ink-3 mt-2">
            Log fridge, freezer &amp; hot-hold temps on the go. The system flags anything{' '}
            <b className="text-ink font-medium">out of its safe range</b> and keeps the record.
          </p>
        </div>
        <div className="flex gap-2 items-center shrink-0">
          <button
            onClick={p.onExport}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-[9px] text-[13px] font-medium border border-line bg-paper text-ink-2 hover:border-ink-3 transition-colors"
          >
            <Download size={13} className="text-ink-3" /> Export Excel
          </button>
          <button
            onClick={() => p.setAddOpen(!p.addOpen)}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-[9px] text-[13px] font-medium bg-ink text-paper border border-ink hover:bg-[#18181b]"
          >
            <span className="text-gold font-semibold">+</span> Add unit
          </button>
        </div>
      </div>

      {p.addOpen && <AddUnitBar handlers={handlers} rcLabel={p.rcLabel} onDone={() => p.setAddOpen(false)} />}

      {view === 'today' ? (
        <TodayView units={units} metrics={m} handlers={handlers} ringColor={ringColor} />
      ) : (
        <HistoryView {...p} />
      )}

      <div className="mt-[18px] font-mono text-[10.5px] text-ink-3 flex justify-between">
        <span>TEMP LOG · {m.readings} READING{m.readings === 1 ? '' : 'S'} TODAY · SAVED TO THE RECORD</span>
      </div>
    </div>
  )
}

function ChromeItem({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'bad' }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="font-mono text-[10px] text-ink-4 uppercase tracking-[0.02em]">{label}</span>
      <span className={`font-mono text-[14px] font-semibold ${tone === 'bad' ? 'text-[#fca5a5]' : tone === 'ok' ? 'text-[#86efac]' : 'text-paper'}`}>
        {value}
      </span>
    </div>
  )
}

function Tab({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-[18px] h-12 text-[13.5px] font-medium border-b-2 -mb-px ${
        active ? 'text-ink border-gold' : 'text-ink-3 border-transparent'
      }`}
    >
      {icon}
      {children}
    </button>
  )
}

function SubToggle({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-[7px] text-[12.5px] font-medium transition-colors ${
        active ? 'bg-ink text-paper' : 'text-ink-3 hover:text-ink-2'
      }`}
    >
      {children}
    </button>
  )
}

// ── today view ────────────────────────────────────────────────────────────────
function TodayView({
  units, metrics, handlers, ringColor,
}: { units: TempUnit[]; metrics: TempDayMetrics; handlers: TempHandlers; ringColor: string }) {
  const m = metrics
  return (
    <>
      {/* status band */}
      <div className="bg-paper border border-line rounded-xl px-[22px] py-4 mb-5 flex items-center gap-[30px]">
        <BandCell big={`${m.logged}`} sub={`/${m.total}`} label="units logged" />
        <span className="w-px h-[38px] bg-line" />
        <BandCell big={String(m.flagged)} label="out of range" bad={m.flagged > 0} />
        <span className="w-px h-[38px] bg-line" />
        <BandCell big={String(m.readings)} label="readings today" />
        <span className="flex-1" />
        <div className="text-right">
          <div className="font-mono text-[18px] font-semibold tracking-[-0.02em] leading-none">{m.last || '—'}</div>
          <div className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.03em] mt-1.5">last reading</div>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_320px] gap-5">
        {/* groups */}
        <div>
          {TEMP_GROUPS.map(g => {
            const us = units.filter(u => groupOf(u.type) === g.key)
            return (
              <div key={g.key} className="mb-[18px]">
                <div className="flex items-center gap-[11px] px-0.5 pb-2.5">
                  <span className={`w-[26px] h-[26px] rounded-lg grid place-items-center shrink-0 ${GROUP_ICON_CLASS[g.key]}`}>
                    {GROUP_ICON[g.key]}
                  </span>
                  <h3 className="m-0 text-[14px] font-semibold tracking-[-0.015em]">{g.title}</h3>
                  <span className="font-mono text-[10.5px] text-ink-3">{us.length} unit{us.length === 1 ? '' : 's'}</span>
                </div>
                <div className="flex flex-col gap-2.5">
                  {us.length === 0 ? (
                    <div className="bg-paper border border-line rounded-xl px-4 py-3.5 font-mono text-[12.5px] text-ink-3">
                      No units yet — add one to start logging.
                    </div>
                  ) : (
                    us.map(u => <DesktopUnitRow key={u.id} u={u} handlers={handlers} />)
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* sign-off rail */}
        <aside className="flex flex-col gap-3.5">
          <div className="font-mono text-[10px] tracking-[0.08em] text-ink-3 uppercase">Today · sign-off</div>

          <div className="bg-paper border border-line rounded-xl p-[18px] text-center">
            <div className="w-[104px] h-[104px] mx-auto mt-1 mb-3.5 relative grid place-items-center">
              <svg viewBox="0 0 100 100" width="104" height="104" className="absolute inset-0 -rotate-90">
                <circle cx="50" cy="50" r="44" fill="none" stroke="#f4f4f5" strokeWidth="8" />
                <circle
                  cx="50" cy="50" r="44" fill="none" stroke={ringColor} strokeWidth="8" strokeLinecap="round"
                  strokeDasharray={RING_C.toFixed(2)}
                  strokeDashoffset={(RING_C * (1 - m.pct / 100)).toFixed(2)}
                  style={{ transition: 'stroke-dashoffset .3s ease' }}
                />
              </svg>
              <div className="text-[27px] font-semibold tracking-[-0.04em]">
                {m.pct}<small className="text-[13px] text-ink-3">%</small>
              </div>
            </div>
            <SignoffMessage metrics={m} />
          </div>

          <RailCard title="Out of range" count={m.flagged}>
            {m.flagItems.length === 0 ? (
              <div className="py-2.5 text-[12.5px] text-green-text font-medium">Nothing out of range.</div>
            ) : (
              m.flagItems.map(u => {
                const rs = u.readings ?? []
                const bad = rs.filter(r => isSafe(u, r.temp) === false).slice(-1)[0]
                return (
                  <div key={u.id} className="flex items-center gap-2.5 py-2.5 border-b border-dashed border-line last:border-0 text-[12.5px]">
                    <span className="w-[7px] h-[7px] rounded-full bg-red shrink-0" />
                    <span className="font-medium">{u.name}</span>
                    <span className="font-mono text-[11px] text-red-text font-semibold ml-auto">
                      {bad ? fmtTemp(bad.temp) : '—'}° · {rangeText(u)}
                    </span>
                  </div>
                )
              })
            )}
          </RailCard>

          <RailCard title="Awaiting reading" count={m.waitItems.length}>
            {m.waitItems.length === 0 ? (
              <div className="py-2.5 text-[12.5px] text-ink-3">Every unit logged.</div>
            ) : (
              m.waitItems.map(u => (
                <div key={u.id} className="flex items-center gap-2.5 py-2.5 border-b border-dashed border-line last:border-0 text-[12.5px]">
                  <span className="w-[7px] h-[7px] rounded-full bg-ink-4 shrink-0" />
                  <span className="font-medium">{u.name}</span>
                  <span className="font-mono text-[11px] text-ink-3 font-semibold ml-auto">{TEMP_TYPES[u.type].label}</span>
                </div>
              ))
            )}
          </RailCard>
        </aside>
      </div>
    </>
  )
}

function BandCell({ big, sub, label, bad }: { big: string; sub?: string; label: string; bad?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className={`text-[28px] font-semibold tracking-[-0.04em] leading-none flex items-baseline gap-1.5 ${bad ? 'text-red-text' : ''}`}>
        {big}
        {sub && <span className="text-ink-4 font-medium text-[18px]">{sub}</span>}
      </div>
      <div className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.03em]">{label}</div>
    </div>
  )
}

function SignoffMessage({ metrics }: { metrics: TempDayMetrics }) {
  const m = metrics
  let title = 'Awaiting readings'
  let sub = m.total ? 'Log every unit at least once today.' : 'Add a unit to start logging.'
  let pill = `${m.total - m.logged} unit${m.total - m.logged === 1 ? '' : 's'} left`
  let pillClass = 'bg-gold-soft text-gold-2'
  if (m.flagged) {
    title = 'Action needed'
    sub = `${m.flagged} unit${m.flagged > 1 ? 's' : ''} reading outside the safe range — re-check & escalate.`
    pill = `${m.flagged} out of range`
    pillClass = 'bg-red-soft text-red-text'
  } else if (m.allClear) {
    title = 'All clear'
    sub = 'Every unit logged and within range today.'
    pill = 'Day signed off'
    pillClass = 'bg-green-soft text-green-text'
  }
  return (
    <>
      <div className="text-[15px] font-semibold tracking-[-0.015em]">{title}</div>
      <div className="font-mono text-[10.5px] text-ink-3 mt-1.5 leading-[1.5]">{sub}</div>
      <div className={`inline-flex items-center gap-1.5 mt-3.5 px-3.5 py-2 rounded-full text-[12.5px] font-semibold ${pillClass}`}>{pill}</div>
    </>
  )
}

function RailCard({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div className="bg-paper border border-line rounded-xl p-[18px]">
      <h4 className="m-0 mb-3 text-[13px] font-semibold tracking-[-0.01em] flex items-center gap-2">
        {title} <span className="font-mono text-[10px] text-ink-3 font-normal ml-auto">{count}</span>
      </h4>
      <div className="flex flex-col">{children}</div>
    </div>
  )
}

// ── one desktop unit row (inline editable + log control) ──────────────────────
function DesktopUnitRow({ u, handlers }: { u: TempUnit; handlers: TempHandlers }) {
  const readings = u.readings ?? []
  const st = unitStatus(u, readings)
  const [temp, setTemp] = useState('')
  const [time, setTime] = useState(nowHM())
  const [name, setName] = useState(u.name)
  const [min, setMin] = useState(u.safeMin == null ? '' : String(u.safeMin))
  const [max, setMax] = useState(u.safeMax == null ? '' : String(u.safeMax))

  const doLog = () => {
    const raw = temp.trim()
    if (raw === '' || Number.isNaN(Number(raw))) return
    handlers.logReading(u.id, Number(raw), time || nowHM())
    setTemp('')
    setTime(nowHM())
  }
  const commitName = () => {
    const n = name.trim()
    if (n && n !== u.name) handlers.updateUnit(u.id, { name: n })
    else setName(u.name)
  }
  const commitRange = () => {
    handlers.updateUnit(u.id, {
      safeMin: min.trim() === '' ? null : Number(min),
      safeMax: max.trim() === '' ? null : Number(max),
    })
  }

  const statusBadge =
    st === 'bad'
      ? <span className="font-mono text-[10px] px-2.5 py-1 rounded-full font-semibold uppercase tracking-[0.02em] bg-red-soft text-red-text">Out of range</span>
      : st === 'ok'
      ? <span className="font-mono text-[10px] px-2.5 py-1 rounded-full font-semibold uppercase tracking-[0.02em] bg-green-soft text-green-text">In range</span>
      : <span className="font-mono text-[10px] px-2.5 py-1 rounded-full font-semibold uppercase tracking-[0.02em] bg-bg-2 text-ink-3">Awaiting</span>

  return (
    <div
      className="bg-paper border rounded-xl px-4 pt-3.5 pb-3 transition-colors"
      style={st === 'bad' ? { borderColor: '#fca5a5', boxShadow: 'inset 3px 0 0 #dc2626' } : { borderColor: '#e4e4e7' }}
    >
      <div className="flex items-center gap-3">
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          aria-label="Unit name"
          className="text-[14.5px] font-semibold tracking-[-0.015em] text-ink bg-transparent border border-transparent rounded-md px-[7px] -mx-[7px] w-[190px] outline-none hover:border-line focus:border-ink-3 focus:bg-bg"
        />
        <div className="flex items-center gap-1.5 font-mono text-[11px] text-ink-3">
          <span className="uppercase tracking-[0.03em] text-ink-4">Safe</span>
          <input
            value={min} type="number" step="0.1" placeholder="min" aria-label="Minimum safe temp"
            onChange={e => setMin(e.target.value)} onBlur={commitRange}
            className="font-mono text-[12px] font-semibold border border-line bg-bg rounded-md py-1 px-[5px] w-12 text-center text-ink-2 outline-none focus:border-ink-3 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
          />
          <span>–</span>
          <input
            value={max} type="number" step="0.1" placeholder="max" aria-label="Maximum safe temp"
            onChange={e => setMax(e.target.value)} onBlur={commitRange}
            className="font-mono text-[12px] font-semibold border border-line bg-bg rounded-md py-1 px-[5px] w-12 text-center text-ink-2 outline-none focus:border-ink-3 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
          />
          <span>°C</span>
        </div>
        <span className="flex-1" />
        {statusBadge}
        <button
          onClick={() => { if (confirm(`Delete "${u.name}"? Its readings stay in History.`)) handlers.deleteUnit(u.id) }}
          aria-label="Delete unit"
          className="w-7 h-7 rounded-[7px] grid place-items-center text-ink-4 hover:bg-red-soft hover:text-red-text shrink-0"
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div className="flex items-center gap-2 flex-wrap mt-3 pt-3 border-t border-dashed border-line">
        <span className="font-mono text-[9.5px] text-ink-4 tracking-[0.04em] uppercase mr-0.5">Today</span>
        {readings.length === 0 ? (
          <span className="font-mono text-[11px] text-ink-4">no reading yet</span>
        ) : (
          readings.map(r => {
            const ok = isSafe(u, r.temp) !== false
            return (
              <span
                key={r.id}
                className={`group inline-flex items-center gap-[7px] font-mono text-[11.5px] border rounded-lg py-[5px] px-2 ${
                  ok ? 'bg-green-soft border-[#bbf7d0] text-green-text' : 'bg-red-soft border-[#fca5a5] text-red-text'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${ok ? 'bg-green' : 'bg-red'}`} />
                <span className={ok ? 'text-green-text/70' : 'text-red-text/70'}>{r.time}</span>
                <span className="font-semibold">{fmtTemp(r.temp)}°</span>
                <button
                  onClick={() => handlers.removeReading(r.id, u.id)}
                  className="opacity-0 group-hover:opacity-100 grid place-items-center hover:text-red-text"
                  aria-label="Remove reading"
                >
                  <X size={11} />
                </button>
              </span>
            )
          })
        )}
        {/* log control */}
        <span className="inline-flex items-center gap-1.5 ml-auto bg-bg-2 border border-line rounded-[9px] py-1 pl-2.5 pr-1">
          <input
            value={temp} type="number" step="0.1" inputMode="decimal" placeholder="temp" aria-label="New temperature"
            onChange={e => setTemp(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') doLog() }}
            className="font-mono text-[13px] font-semibold bg-transparent w-[52px] text-right text-ink outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
          />
          <span className="font-mono text-[11px] text-ink-4">°C</span>
          <input
            value={time} type="time" aria-label="Reading time"
            onChange={e => setTime(e.target.value)}
            className="font-mono text-[11px] text-ink-3 bg-transparent outline-none w-[82px] border-l border-line pl-[7px]"
          />
          <button onClick={doLog} className="font-mono text-[11px] font-semibold bg-ink text-paper rounded-[7px] py-1.5 px-[11px] inline-flex items-center gap-1.5 hover:bg-ink-2">
            <Plus size={11} /> Log
          </button>
        </span>
      </div>
    </div>
  )
}

// ── add-unit bar (desktop inline) ─────────────────────────────────────────────
function AddUnitBar({ handlers, rcLabel, onDone }: { handlers: TempHandlers; rcLabel: string; onDone: () => void }) {
  const [name, setName] = useState('')
  const [type, setType] = useState<TempType>('FRIDGE')
  const def = TEMP_TYPES[type].def
  const [min, setMin] = useState(def.min == null ? '' : String(def.min))
  const [max, setMax] = useState(def.max == null ? '' : String(def.max))
  const pick = (ty: TempType) => {
    setType(ty)
    const d = TEMP_TYPES[ty].def
    setMin(d.min == null ? '' : String(d.min))
    setMax(d.max == null ? '' : String(d.max))
  }
  const submit = () => {
    if (!name.trim()) return
    handlers.addUnit({ name: name.trim(), type, safeMin: min.trim() === '' ? null : Number(min), safeMax: max.trim() === '' ? null : Number(max) })
    onDone()
  }
  return (
    <div className="flex items-center gap-2.5 bg-paper border border-dashed border-line-2 rounded-xl px-3.5 py-3 mb-[18px] flex-wrap">
      <input
        value={name} autoFocus placeholder="Unit name — e.g. Walk-in fridge, Bain-marie 2…"
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onDone() }}
        className="flex-1 min-w-[170px] bg-bg border border-line rounded-lg text-[13.5px] text-ink outline-none px-3 py-2.5"
      />
      <select value={type} onChange={e => pick(e.target.value as TempType)} className="bg-bg border border-line rounded-lg text-[13px] text-ink-2 px-2.5 py-2.5 outline-none cursor-pointer">
        <option value="FRIDGE">Fridge</option>
        <option value="FREEZER">Freezer</option>
        <option value="HOT">Hot held food</option>
      </select>
      <div className="flex items-center gap-1.5 font-mono text-[10.5px] text-ink-3 bg-bg-2 border border-line rounded-lg px-2.5 py-1.5">
        SAFE
        <input value={min} type="number" step="0.1" placeholder="min" onChange={e => setMin(e.target.value)} className="font-mono text-[12px] font-semibold border border-line bg-paper rounded-md py-1 px-[5px] w-12 text-center text-ink-2 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none" />
        <span>–</span>
        <input value={max} type="number" step="0.1" placeholder="max" onChange={e => setMax(e.target.value)} className="font-mono text-[12px] font-semibold border border-line bg-paper rounded-md py-1 px-[5px] w-12 text-center text-ink-2 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none" />
        °C
      </div>
      <button onClick={submit} disabled={!name.trim()} className="font-mono text-[11.5px] px-[15px] py-2.5 rounded-lg bg-ink text-paper font-semibold disabled:opacity-40 disabled:cursor-not-allowed">
        Add unit
      </button>
      <button onClick={onDone} className="text-ink-3 grid place-items-center p-1.5"><X size={15} /></button>
      <div className="basis-full font-mono text-[10.5px] text-ink-3">Adds to <span className="font-semibold text-ink-2">{rcLabel}</span></div>
    </div>
  )
}

// ── history view (desktop) ────────────────────────────────────────────────────
function HistoryView(p: TempDesktopProps) {
  const { history, units } = p
  // group by day
  const byDay: Record<string, HistoryReading[]> = {}
  history.forEach(r => {
    if (p.histUnit && r.unitId !== p.histUnit) return
    ;(byDay[r.logDate] ||= []).push(r)
  })
  const dates = Object.keys(byDay).sort().reverse()

  return (
    <div>
      <div className="flex items-center gap-2.5 mb-4">
        <div className="inline-flex rounded-[9px] border border-line bg-paper p-0.5">
          <SubToggle active={p.histView === 'day'} onClick={() => p.setHistView('day')}>By day</SubToggle>
          <SubToggle active={p.histView === 'equipment'} onClick={() => p.setHistView('equipment')}>By equipment</SubToggle>
        </div>
        <select value={p.histUnit} onChange={e => p.setHistUnit(e.target.value)} className="bg-paper border border-line rounded-[9px] px-3 py-2.5 text-[13px] text-ink-2 outline-none cursor-pointer">
          <option value="">All units</option>
          {units.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <select value={p.histRange} onChange={e => p.setHistRange(e.target.value)} className="bg-paper border border-line rounded-[9px] px-3 py-2.5 text-[13px] text-ink-2 outline-none cursor-pointer">
          <option value="7">Last 7 days</option>
          <option value="14">Last 14 days</option>
          <option value="30">Last 30 days</option>
          <option value="0">All time</option>
        </select>
        <span className="flex-1" />
        <button onClick={p.onExport} className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-[9px] text-[13px] font-medium border border-line bg-paper text-ink-2 hover:border-ink-3">
          <Download size={13} className="text-ink-3" /> Export Excel
        </button>
      </div>

      {p.histView === 'equipment' ? (
        p.histLoading ? (
          <div className="text-center py-16 font-mono text-[11px] text-ink-4">LOADING…</div>
        ) : (
          <TempEquipmentView units={units} history={history} histUnit={p.histUnit} />
        )
      ) : p.histLoading ? (
        <div className="text-center py-16 font-mono text-[11px] text-ink-4">LOADING…</div>
      ) : dates.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-[60px] text-center text-ink-3">
          <div className="w-12 h-12 rounded-full bg-bg-2 grid place-items-center text-ink-4 mb-3.5"><Clock size={20} /></div>
          <div className="text-[14px] text-ink-2 font-medium">No readings in this range</div>
          <div className="text-[12.5px] text-ink-3 mt-1">Log temps on the Today tab to build the record.</div>
        </div>
      ) : (
        dates.map(date => {
          const rows = [...byDay[date]].sort((a, b) => a.time.localeCompare(b.time))
          const flags = rows.filter(r => isSafe(r.unit, r.temp) === false).length
          return (
            <div key={date} className="mb-5">
              <div className="flex items-baseline gap-3 mb-2.5 px-0.5">
                <span className="text-[14px] font-semibold tracking-[-0.01em]">{prettyDate(date)}{date === p.today ? ' · Today' : ''}</span>
                <span className="font-mono text-[10.5px] text-ink-3">
                  {rows.length} reading{rows.length === 1 ? '' : 's'}{flags > 0 && <> · <b className="text-red-text">{flags} out of range</b></>}
                </span>
              </div>
              <div className="bg-paper border border-line rounded-xl overflow-hidden">
                <div className="grid grid-cols-[1.4fr_0.9fr_0.8fr_0.7fr_0.7fr_0.9fr] gap-3 items-center px-[18px] py-2.5 bg-bg-2 border-b border-line font-mono text-[10px] text-ink-3 tracking-[0.03em] uppercase">
                  <span>Unit</span><span>Type</span><span>Safe range</span><span>Time</span><span>Temp</span><span>Status</span>
                </div>
                {rows.map(r => {
                  const safe = isSafe(r.unit, r.temp)
                  return (
                    <div key={r.id} className="grid grid-cols-[1.4fr_0.9fr_0.8fr_0.7fr_0.7fr_0.9fr] gap-3 items-center px-[18px] py-[11px] border-b border-line last:border-0 text-[13px] hover:bg-bg">
                      <span className="font-medium tracking-[-0.005em]">{r.unit.name}</span>
                      <span className="font-mono text-[12.5px] text-ink-2">{TEMP_TYPES[r.unit.type].label}</span>
                      <span className="font-mono text-[12.5px] text-ink-2">{rangeText(r.unit)}</span>
                      <span className="font-mono text-[12.5px] text-ink-2">{r.time}</span>
                      <span className={`font-mono text-[13px] font-semibold ${safe === false ? 'text-red-text' : 'text-green-text'}`}>{fmtTemp(r.temp)}°C</span>
                      <span>
                        <span className={`font-mono text-[10px] px-2 py-[3px] rounded-full font-medium uppercase inline-flex items-center gap-1 ${safe === false ? 'bg-red-soft text-red-text' : 'bg-green-soft text-green-text'}`}>
                          {safe === false ? 'OUT' : 'OK'}
                        </span>
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })
      )}
    </div>
  )
}
