'use client'
import { useState, useEffect } from 'react'
import {
  Plus, Minus, X, Trash2, Clock, Download, ArrowRight, AlertTriangle, Check, ChevronDown, ChevronRight,
} from 'lucide-react'
import { Sheet } from './Sheet'
import {
  TEMP_TYPES, TEMP_GROUPS, groupOf, isSafe, rangeText, unitStatus, fmtTemp, nowHM, prettyDate,
  type TempUnit, type TempType, type TempHandlers, type TempDayMetrics, type HistoryReading,
} from './temp-utils'

type SheetState =
  | { kind: 'log'; uid: string }
  | { kind: 'add'; type: TempType }
  | { kind: 'history' }
  | null

export interface TempMobileProps {
  units: TempUnit[]
  metrics: TempDayMetrics
  handlers: TempHandlers
  today: string
  rcLabel: string
  history: HistoryReading[]
  histLoading: boolean
  ensureHistory: () => void
  onExport: () => void
}

export function TempMobile(p: TempMobileProps) {
  const { units, metrics: m, handlers } = p
  const [sheet, setSheet] = useState<SheetState>(null)

  const openUnit = units.find(u => sheet?.kind === 'log' && u.id === sheet.uid)

  return (
    <div className="md:hidden">
      {/* header */}
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-ink tracking-[-0.02em]">Temp charts</h1>
          <p className="font-mono text-[10.5px] text-ink-3 mt-0.5 uppercase tracking-[0.02em]">
            {new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} · Log
          </p>
        </div>
        <button
          onClick={() => { p.ensureHistory(); setSheet({ kind: 'history' }) }}
          className="h-[38px] px-3 rounded-full bg-paper border border-line inline-flex items-center gap-1.5 text-ink-2 text-[12.5px] font-medium"
        >
          <Clock size={15} className="text-ink-3" /> History
        </button>
      </div>

      {/* rollup spine */}
      <div className="bg-ink text-paper rounded-xl px-4 py-2.5 flex items-center gap-4 mb-4 overflow-x-auto">
        <RollItem label="LOGGED" value={`${m.logged}/${m.total}`} />
        <RollItem label="OUT OF RANGE" value={String(m.flagged)} tone={m.flagged ? 'bad' : 'ok'} />
        <RollItem label="READINGS" value={String(m.readings)} />
        <RollItem label="LAST" value={m.last || '—'} />
      </div>

      {/* groups */}
      {TEMP_GROUPS.map(g => {
        const us = units.filter(u => groupOf(u.type) === g.key)
        return (
          <div key={g.key} className="mb-4">
            <div className="flex items-center justify-between px-0.5 mb-2">
              <span className="font-mono text-[10px] tracking-[0.06em] text-ink-3 uppercase">{g.title}</span>
              <span className="font-mono text-[10px] text-ink-4">{us.length} unit{us.length === 1 ? '' : 's'}</span>
            </div>
            <div className="flex flex-col gap-2">
              {us.length === 0 && <div className="font-mono text-[11px] text-ink-4 px-0.5 py-1">No units yet.</div>}
              {us.map(u => (
                <MobileUnitRow key={u.id} u={u} readings={u.readings ?? []} onTap={() => setSheet({ kind: 'log', uid: u.id })} />
              ))}
              <button
                onClick={() => setSheet({ kind: 'add', type: g.type })}
                className="inline-flex items-center justify-center gap-1.5 w-full h-[42px] rounded-xl bg-transparent border border-dashed border-line-2 text-ink-3 text-[13px] font-medium"
              >
                <Plus size={15} /> Add {TEMP_TYPES[g.type].label.toLowerCase()}
              </button>
            </div>
          </div>
        )
      })}
      <div className="h-3" />

      {/* log sheet */}
      <Sheet open={!!openUnit} onClose={() => setSheet(null)} title={openUnit?.name}>
        {openUnit && (
          <LogBody
            u={openUnit}
            readings={openUnit.readings ?? []}
            handlers={handlers}
            onClose={() => setSheet(null)}
          />
        )}
      </Sheet>

      {/* add-unit sheet */}
      <Sheet open={sheet?.kind === 'add'} onClose={() => setSheet(null)} title="Add unit">
        {sheet?.kind === 'add' && (
          <AddUnitBody
            initialType={sheet.type}
            rcLabel={p.rcLabel}
            onAdd={u => { handlers.addUnit(u); setSheet(null) }}
          />
        )}
      </Sheet>

      {/* history sheet */}
      <Sheet open={sheet?.kind === 'history'} onClose={() => setSheet(null)} title="History">
        {sheet?.kind === 'history' && (
          <HistoryBody units={units} history={p.history} loading={p.histLoading} today={p.today} onExport={p.onExport} />
        )}
      </Sheet>
    </div>
  )
}

function RollItem({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'bad' }) {
  return (
    <div className="flex flex-col gap-0.5 shrink-0">
      <span className="font-mono text-[9px] text-ink-4 tracking-[0.04em]">{label}</span>
      <span className={`font-mono text-[15px] font-semibold ${tone === 'bad' ? 'text-[#fca5a5]' : tone === 'ok' ? 'text-[#86efac]' : 'text-paper'}`}>{value}</span>
    </div>
  )
}

// ── mobile unit row (big touch target) ────────────────────────────────────────
function MobileUnitRow({ u, readings, onTap }: { u: TempUnit; readings: TempUnit['readings']; onTap: () => void }) {
  const rs = readings ?? []
  const status = unitStatus(u, rs)
  const last = rs.length ? rs[rs.length - 1] : null
  const color = TEMP_TYPES[u.type].color
  return (
    <button
      onClick={onTap}
      className="flex items-center gap-3 w-full text-left bg-paper border rounded-2xl px-3 py-[13px]"
      style={status === 'bad' ? { borderColor: '#fca5a5', boxShadow: 'inset 3px 0 0 #dc2626' } : { borderColor: '#e4e4e7' }}
    >
      <span className="w-[9px] h-[9px] rounded-full shrink-0" style={{ background: color }} />
      <div className="flex-1 min-w-0">
        <div className="text-[15px] font-semibold tracking-[-0.01em] truncate">{u.name}</div>
        <div className="font-mono text-[10.5px] text-ink-3 mt-[3px]">
          safe {rangeText(u)}{last ? ` · last ${last.time} · ${fmtTemp(last.temp)}°` : ' · no reading yet'}
        </div>
      </div>
      {status === 'wait' ? (
        <span className="inline-flex items-center gap-1.5 font-mono text-[11px] font-semibold text-gold bg-ink py-2 px-3 rounded-[10px] tracking-[0.02em]">
          LOG <ArrowRight size={13} className="text-gold" />
        </span>
      ) : (
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <span className="font-mono text-[17px] font-semibold tracking-[-0.02em]" style={{ color: status === 'bad' ? '#b91c1c' : '#09090b' }}>
            {fmtTemp(last!.temp)}°
          </span>
          <span className={`font-mono text-[10px] px-2 py-0.5 rounded-full font-medium uppercase ${status === 'bad' ? 'bg-red-soft text-red-text' : 'bg-green-soft text-green-text'}`}>
            {status === 'bad' ? 'OUT' : 'OK'}{rs.length > 1 ? ` · ${rs.length}` : ''}
          </span>
        </div>
      )}
    </button>
  )
}

// ── log sheet body (big stepper) ──────────────────────────────────────────────
function LogBody({ u, readings, handlers, onClose }: { u: TempUnit; readings: TempUnit['readings']; handlers: TempHandlers; onClose: () => void }) {
  const rs = readings ?? []
  const mid = u.safeMin != null && u.safeMax != null ? (u.safeMin + u.safeMax) / 2 : u.safeMax != null ? u.safeMax - 1 : u.safeMin != null ? u.safeMin + 3 : 4
  const seed = rs.length ? rs[rs.length - 1].temp : Math.round(mid)
  const [val, setVal] = useState(+(+seed).toFixed(1))
  const [time, setTime] = useState(nowHM())
  const [editTime, setEditTime] = useState(false)
  const [showRange, setShowRange] = useState(false)
  const [minBuf, setMinBuf] = useState(u.safeMin == null ? '' : String(u.safeMin))
  const [maxBuf, setMaxBuf] = useState(u.safeMax == null ? '' : String(u.safeMax))
  const [editing, setEditing] = useState(false)
  const [buf, setBuf] = useState('')

  const safe = isSafe(u, val)
  const banner =
    safe === null
      ? { cls: 'bg-bg-2 text-ink-3', icon: <Clock size={17} />, txt: 'Enter a temperature' }
      : safe
      ? { cls: 'bg-green-soft text-green-text', icon: <Check size={17} />, txt: 'In range — safe' }
      : { cls: 'bg-red-soft text-red-text', icon: <AlertTriangle size={17} />, txt: 'Out of range — re-check & escalate' }

  const commitNum = () => {
    const n = parseFloat(buf)
    if (!Number.isNaN(n)) setVal(+n.toFixed(1))
    setEditing(false)
  }
  const commitRange = () => {
    handlers.updateUnit(u.id, { safeMin: minBuf.trim() === '' ? null : Number(minBuf), safeMax: maxBuf.trim() === '' ? null : Number(maxBuf) })
  }

  return (
    <div className="pb-1">
      <div className="font-mono text-[10.5px] text-ink-3 -mt-0.5 mb-3 uppercase tracking-[0.02em]">
        {TEMP_TYPES[u.type].label} · Safe {rangeText(u)}
      </div>

      {/* live banner */}
      <div className={`rounded-xl px-3.5 py-2.5 flex items-center gap-2 mb-3.5 text-[14px] font-semibold tracking-[-0.01em] ${banner.cls}`}>
        {banner.icon} {banner.txt}
      </div>

      {/* big stepper */}
      <div className="bg-bg rounded-2xl px-4 pt-5 pb-4 mb-3">
        <div className="flex items-center justify-between gap-3">
          <button onClick={() => setVal(v => +(v - 0.1).toFixed(1))} className="w-[66px] h-[66px] rounded-[18px] grid place-items-center bg-bg-2 text-ink-2 border border-line shrink-0">
            <Minus size={26} />
          </button>
          <div className="flex-1 text-center min-w-0">
            {editing ? (
              <input
                value={buf} autoFocus type="number" inputMode="decimal" step="0.1"
                onChange={e => setBuf(e.target.value)} onBlur={commitNum}
                onKeyDown={e => { if (e.key === 'Enter') commitNum() }}
                className="w-[150px] text-center text-[56px] font-semibold tracking-[-0.04em] text-ink border-0 border-b-2 border-gold bg-transparent outline-none p-0"
              />
            ) : (
              <div onClick={() => { setBuf(String(val)); setEditing(true) }} className="cursor-text">
                <span className="text-[62px] font-semibold leading-none tracking-[-0.04em]">{fmtTemp(val)}</span>
                <span className="text-[26px] font-medium text-ink-3 ml-0.5">°C</span>
              </div>
            )}
            <div className="font-mono text-[10.5px] text-ink-3 mt-1.5">tap number to type</div>
          </div>
          <button onClick={() => setVal(v => +(v + 0.1).toFixed(1))} className="w-[66px] h-[66px] rounded-[18px] grid place-items-center bg-ink text-gold shrink-0">
            <Plus size={26} />
          </button>
        </div>
        <div className="flex justify-center gap-1.5 mt-3.5">
          {[-1, -0.1, 0.1, 1].map(d => (
            <button key={d} onClick={() => setVal(v => +(v + d).toFixed(1))} className="font-mono text-[12.5px] font-semibold px-3 py-2 rounded-[10px] bg-paper border border-line text-ink-2 min-w-[52px]">
              {d > 0 ? '+' : ''}{d}
            </button>
          ))}
        </div>
      </div>

      {/* time */}
      <div className="flex items-center gap-2.5 mb-3.5">
        <span className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.04em]">Logged at</span>
        {editTime ? (
          <input type="time" value={time} autoFocus onChange={e => setTime(e.target.value)} onBlur={() => setEditTime(false)}
            className="font-mono text-[14px] font-semibold text-ink bg-bg border border-line-2 rounded-[9px] px-2.5 py-1.5 outline-none" />
        ) : (
          <button onClick={() => setEditTime(true)} className="font-mono text-[14px] font-semibold text-ink bg-bg-2 rounded-[9px] px-3 py-2 inline-flex items-center gap-1.5">
            {time} <Clock size={13} className="text-ink-3" />
          </button>
        )}
        <button onClick={() => { setTime(nowHM()); setEditTime(false) }} className="font-mono text-[11px] font-semibold text-gold-2 tracking-[0.02em]">NOW</button>
      </div>

      {/* today's readings */}
      {rs.length > 0 && (
        <>
          <div className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.04em] mb-2">Today · {rs.length} reading{rs.length === 1 ? '' : 's'}</div>
          <div className="flex gap-1.5 overflow-x-auto -mx-[18px] px-[18px] pb-0.5 mb-3.5">
            {rs.map(r => {
              const ok = isSafe(u, r.temp) !== false
              return (
                <span key={r.id} className={`shrink-0 inline-flex items-center gap-1.5 font-mono text-[12px] border rounded-[9px] px-2 py-1.5 ${ok ? 'bg-green-soft text-green-text border-[#bbf7d0]' : 'bg-red-soft text-red-text border-[#fca5a5]'}`}>
                  <span style={{ color: ok ? '#16a34a' : '#dc2626' }}>{r.time}</span>
                  <b className="font-semibold">{fmtTemp(r.temp)}°</b>
                  <button onClick={() => handlers.removeReading(r.id, u.id)} className="opacity-60 grid place-items-center"><X size={12} /></button>
                </span>
              )
            })}
          </div>
        </>
      )}

      {/* primary log */}
      <button
        onClick={() => { handlers.logReading(u.id, val, time); onClose() }}
        className={`w-full h-[52px] rounded-2xl inline-flex items-center justify-center gap-2 text-[15px] font-semibold tracking-[-0.01em] ${
          safe === false ? 'bg-red text-white' : 'bg-ink text-paper'
        }`}
      >
        {safe === false ? <AlertTriangle size={18} /> : <Plus size={18} className="text-gold" />}
        {safe === false ? `Log out-of-range · ${fmtTemp(val)}°C` : `Log ${fmtTemp(val)}°C`}
      </button>

      {/* settings */}
      <button onClick={() => setShowRange(s => !s)} className="mt-4 w-full flex items-center justify-between px-0.5 py-1.5 text-ink-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.04em]">Unit settings</span>
        {showRange ? <ChevronDown size={15} className="text-ink-4" /> : <ChevronRight size={15} className="text-ink-4" />}
      </button>
      {showRange && (
        <div className="bg-bg rounded-xl p-3.5 mt-1">
          <div className="font-mono text-[10.5px] text-ink-3 mb-2.5 uppercase tracking-[0.02em]">Safe range — leave a side blank for one-sided limits</div>
          <div className="flex items-center gap-2.5 mb-3">
            <RangeField label="MIN °C" value={minBuf} onChange={setMinBuf} onCommit={commitRange} />
            <span className="text-ink-4 mt-3.5">–</span>
            <RangeField label="MAX °C" value={maxBuf} onChange={setMaxBuf} onCommit={commitRange} />
          </div>
          <button
            onClick={() => { if (confirm(`Delete "${u.name}"? Its readings stay in History.`)) { handlers.deleteUnit(u.id); onClose() } }}
            className="inline-flex items-center gap-1.5 font-mono text-[12px] font-semibold text-red-text bg-red-soft rounded-[10px] px-3 py-2.5"
          >
            <Trash2 size={14} /> Delete unit
          </button>
        </div>
      )}
    </div>
  )
}

function RangeField({ label, value, onChange, onCommit }: { label: string; value: string; onChange: (v: string) => void; onCommit: () => void }) {
  return (
    <div className="flex-1">
      <div className="font-mono text-[9.5px] text-ink-4 tracking-[0.04em] mb-1.5">{label}</div>
      <input
        value={value} type="number" inputMode="decimal" step="0.1" placeholder="—"
        onChange={e => onChange(e.target.value)} onBlur={onCommit}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        className="w-full h-11 text-center font-mono text-[16px] font-semibold text-ink bg-paper border border-line rounded-[10px] outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
      />
    </div>
  )
}

// ── add-unit sheet body ───────────────────────────────────────────────────────
function AddUnitBody({ initialType, rcLabel, onAdd }: { initialType: TempType; rcLabel: string; onAdd: (u: { name: string; type: TempType; safeMin: number | null; safeMax: number | null }) => void }) {
  const [name, setName] = useState('')
  const [type, setType] = useState<TempType>(initialType)
  const def = TEMP_TYPES[initialType].def
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
    onAdd({ name: name.trim(), type, safeMin: min.trim() === '' ? null : Number(min), safeMax: max.trim() === '' ? null : Number(max) })
  }
  return (
    <div className="pb-1">
      <div className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.04em] mb-2">Unit name</div>
      <input
        value={name} autoFocus placeholder="e.g. Dessert fridge, Bain-marie 2…"
        onChange={e => setName(e.target.value)}
        className="w-full h-12 bg-bg border border-line rounded-xl px-3.5 text-[15.5px] text-ink outline-none tracking-[-0.01em] mb-4"
      />

      <div className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.04em] mb-2">Type</div>
      <div className="flex gap-2 mb-4">
        {(Object.keys(TEMP_TYPES) as TempType[]).map(ty => {
          const on = type === ty
          return (
            <button key={ty} onClick={() => pick(ty)} className={`flex-1 flex flex-col items-center gap-1.5 py-3 px-1.5 rounded-[13px] border ${on ? 'bg-ink border-ink' : 'bg-paper border-line'}`}>
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: TEMP_TYPES[ty].color }} />
              <span className={`text-[12.5px] tracking-[-0.01em] text-center leading-[1.15] ${on ? 'text-paper font-semibold' : 'text-ink-2 font-medium'}`}>{TEMP_TYPES[ty].label}</span>
            </button>
          )
        })}
      </div>

      <div className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.04em] mb-2">Safe range</div>
      <div className="flex items-center gap-2.5 mb-4">
        <RangeField label="MIN °C" value={min} onChange={setMin} onCommit={() => {}} />
        <span className="text-ink-4 mt-3.5">–</span>
        <RangeField label="MAX °C" value={max} onChange={setMax} onCommit={() => {}} />
      </div>

      <div className="font-mono text-[10px] text-ink-3 mb-3">Adds to <span className="font-semibold text-ink-2">{rcLabel}</span></div>

      <button onClick={submit} className="w-full h-[52px] rounded-2xl bg-ink text-paper inline-flex items-center justify-center gap-2 text-[15px] font-semibold" style={{ opacity: name.trim() ? 1 : 0.45 }}>
        <Plus size={18} className="text-gold" /> Add unit
      </button>
    </div>
  )
}

// ── history sheet body ────────────────────────────────────────────────────────
function HistoryBody({ units, history, loading, today, onExport }: { units: TempUnit[]; history: HistoryReading[]; loading: boolean; today: string; onExport: () => void }) {
  const [unit, setUnit] = useState('')
  const byDay: Record<string, HistoryReading[]> = {}
  history.forEach(r => {
    if (unit && r.unitId !== unit) return
    ;(byDay[r.logDate] ||= []).push(r)
  })
  const dates = Object.keys(byDay).sort().reverse()

  return (
    <div className="pb-2">
      <div className="flex gap-1.5 overflow-x-auto -mx-[18px] px-[18px] pb-1">
        {[{ id: '', name: 'All units' }, ...units].map(o => {
          const on = unit === o.id
          return (
            <button key={o.id || 'all'} onClick={() => setUnit(o.id)} className={`shrink-0 font-mono text-[12px] px-3 py-1.5 rounded-full whitespace-nowrap border ${on ? 'bg-ink text-paper border-ink' : 'bg-paper text-ink-2 border-line'}`}>
              {o.name}
            </button>
          )
        })}
      </div>

      <button onClick={onExport} className="inline-flex items-center gap-2 my-3 text-[13px] font-semibold text-ink-2 bg-bg-2 rounded-[10px] px-3.5 py-2.5 tracking-[-0.01em]">
        <Download size={16} className="text-ink-3" /> Export to Excel (.csv)
      </button>

      {loading ? (
        <div className="font-mono text-[11px] text-ink-4 text-center py-10">LOADING…</div>
      ) : dates.length === 0 ? (
        <div className="font-mono text-[11px] text-ink-4 text-center py-10">NO READINGS YET</div>
      ) : (
        dates.map(date => {
          const rows = [...byDay[date]].sort((a, b) => a.time.localeCompare(b.time))
          const flags = rows.filter(r => isSafe(r.unit, r.temp) === false).length
          return (
            <div key={date} className="mt-[18px]">
              <div className="flex justify-between items-center mb-2 font-mono text-[10px] uppercase tracking-[0.04em]">
                <span className="text-ink-2">{prettyDate(date)}{date === today ? ' · Today' : ''}</span>
                <span style={{ color: flags ? '#b91c1c' : '#a1a1aa' }}>{rows.length} · {flags ? `${flags} OUT` : 'ALL OK'}</span>
              </div>
              <div className="bg-paper border border-line rounded-xl overflow-hidden">
                {rows.map((r, i) => (
                  <div key={r.id} className={`flex items-center gap-2.5 px-3 py-[11px] ${i < rows.length - 1 ? 'border-b border-dashed border-line' : ''}`}>
                    <span className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: TEMP_TYPES[r.unit.type].color }} />
                    <span className="flex-1 text-[13.5px] font-medium tracking-[-0.01em] truncate">{r.unit.name}</span>
                    <span className="font-mono text-[11px] text-ink-3">{r.time}</span>
                    <span className="font-mono text-[13.5px] font-semibold tracking-[-0.01em] w-14 text-right" style={{ color: isSafe(r.unit, r.temp) === false ? '#b91c1c' : '#09090b' }}>
                      {fmtTemp(r.temp)}°C
                    </span>
                    <span className={`font-mono text-[10px] px-2 py-0.5 rounded-full font-medium uppercase ${isSafe(r.unit, r.temp) === false ? 'bg-red-soft text-red-text' : 'bg-green-soft text-green-text'}`}>
                      {isSafe(r.unit, r.temp) === false ? 'OUT' : 'OK'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )
        })
      )}
    </div>
  )
}
