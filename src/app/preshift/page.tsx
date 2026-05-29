'use client'
import { useEffect, useMemo, useState, useCallback } from 'react'
import Link from 'next/link'
import {
  Clock, Sun, ChefHat, ClipboardList, AlertTriangle, Mail,
  Package, Activity, Plus, Check, ArrowRight, RotateCcw, Flame,
} from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { useUser } from '@/contexts/UserContext'
import { formatCurrency } from '@/lib/utils'
import { SubNav } from '@/components/layout/SubNav'
import { PageHead } from '@/components/layout/PageHead'

// ── Types ─────────────────────────────────────────────────────────────────

type Priority = 'NOW' | 'SOON' | 'LATER' | 'OFF'

type TaskKind = 'prep' | 'restock' | 'invoice' | 'price' | 'count' | 'custom'

interface Candidate {
  /** Stable id — survives reloads so user priority/done state sticks. */
  id: string
  kind: TaskKind
  title: string
  meta: string
  /** What the system thinks this should be, before the user decides. */
  suggested: Priority
  /** Optional $ / qty hint shown on the right. */
  hint?: { value: string; sub: string; tint?: 'bad' | 'warn' | 'ok' }
  /** Deep link to the tool that resolves this task. */
  href?: string
  ctaLabel?: string
}

interface TaskState {
  priority: Priority
  done: boolean
}

interface CustomTask {
  id: string
  title: string
}

interface PrepItem {
  id: string; name: string; unit: string
  onHand: number; parLevel: number
  priority: '911' | 'NEEDED_TODAY' | 'LATER'
  isBlocked: boolean; blockedReason: string | null
}
interface DashboardData {
  outOfStockItems: Array<{ id: string; itemName: string; category: string; lastValue: number }>
}
interface KPIs { awaitingApprovalCount: number }
interface CountSession {
  id: string; finalizedAt: string | null; status: string
}

// ── Priority vocabulary ─────────────────────────────────────────────────────

const LANES: { key: Exclude<Priority, 'OFF'>; label: string; blurb: string; dot: string }[] = [
  { key: 'NOW',   label: 'Now — before anything', blurb: 'Service-stoppers. Fire these first.', dot: 'bg-red' },
  { key: 'SOON',  label: 'Before doors',          blurb: 'On the board before we open.',        dot: 'bg-gold' },
  { key: 'LATER', label: 'If time',               blurb: 'Nice to have — not blocking service.', dot: 'bg-green' },
]

const PRIORITY_RANK: Record<Priority, number> = { NOW: 0, SOON: 1, LATER: 2, OFF: 3 }

// ── Page ─────────────────────────────────────────────────────────────────

export default function PreshiftPage() {
  const { user } = useUser()
  const { activeRcId } = useRc()

  const [prepItems, setPrepItems] = useState<PrepItem[]>([])
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [inboxKpis, setInboxKpis] = useState<KPIs | null>(null)
  const [countSessions, setCountSessions] = useState<CountSession[]>([])
  const [priceAlertCount, setPriceAlertCount] = useState(0)
  const [loaded, setLoaded] = useState(false)

  // Per-day, per-RC persisted user decisions.
  const storageKey = useMemo(() => {
    const day = ymd(new Date())
    return `preshift:${day}:${activeRcId || 'all'}`
  }, [activeRcId])

  const [states, setStates] = useState<Record<string, TaskState>>({})
  const [custom, setCustom] = useState<CustomTask[]>([])
  const [hydrated, setHydrated] = useState(false)

  // Hydrate from localStorage when the key (day / RC) changes.
  useEffect(() => {
    setHydrated(false)
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw) {
        const parsed = JSON.parse(raw)
        setStates(parsed.states ?? {})
        setCustom(parsed.custom ?? [])
      } else {
        setStates({})
        setCustom([])
      }
    } catch { setStates({}); setCustom([]) }
    setHydrated(true)
  }, [storageKey])

  // Persist on change (after hydration so we never clobber with empty).
  useEffect(() => {
    if (!hydrated) return
    try {
      localStorage.setItem(storageKey, JSON.stringify({ states, custom }))
    } catch { /* quota / private mode — non-fatal */ }
  }, [states, custom, hydrated, storageKey])

  // Pull live signals.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const qs = activeRcId ? `?rcId=${activeRcId}` : ''
        const [p, d, k, s, a] = await Promise.all([
          fetch('/api/prep/items', { cache: 'no-store' }).then(r => r.ok ? r.json() : []),
          fetch(`/api/reports/dashboard${qs}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
          fetch(`/api/invoices/kpis${qs}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
          fetch('/api/count/sessions', { cache: 'no-store' }).then(r => r.ok ? r.json() : []),
          fetch('/api/invoices/alerts', { cache: 'no-store' }).then(r => r.ok ? r.json() : { priceAlerts: [] }),
        ])
        if (cancelled) return
        if (Array.isArray(p)) setPrepItems(p)
        if (d) setDashboard(d)
        if (k) setInboxKpis(k)
        if (Array.isArray(s)) setCountSessions(s)
        if (a?.priceAlerts) setPriceAlertCount(a.priceAlerts.length)
      } catch { /* swallow */ } finally {
        if (!cancelled) setLoaded(true)
      }
    }
    load()
    return () => { cancelled = true }
  }, [activeRcId])

  // ── Build candidate tasks from the signals ────────────────────────────────
  const candidates = useMemo<Candidate[]>(() => {
    const out: Candidate[] = []

    for (const it of prepItems) {
      if (it.priority === 'LATER') continue
      const short = it.parLevel - it.onHand
      out.push({
        id: `prep:${it.id}`,
        kind: 'prep',
        title: `Prep ${it.name}`,
        meta: it.isBlocked && it.blockedReason
          ? `BLOCKED · ${it.blockedReason}`
          : `${fmtQty(it.onHand)} / ${fmtQty(it.parLevel)} ${it.unit} on hand`,
        suggested: it.priority === '911' ? 'NOW' : 'SOON',
        hint: {
          value: short > 0 ? `${fmtQty(short)}` : 'par',
          sub: short > 0 ? `${it.unit} short` : 'on par',
          tint: it.priority === '911' ? 'bad' : 'warn',
        },
        href: '/prep',
        ctaLabel: 'Prep',
      })
    }

    for (const oos of dashboard?.outOfStockItems ?? []) {
      out.push({
        id: `restock:${oos.id}`,
        kind: 'restock',
        title: `Restock ${oos.itemName}`,
        meta: `${oos.category} · out of stock`,
        suggested: 'SOON',
        hint: { value: '0', sub: 'on hand', tint: 'bad' },
        href: '/inventory',
        ctaLabel: 'Inventory',
      })
    }

    if (inboxKpis && inboxKpis.awaitingApprovalCount > 0) {
      out.push({
        id: 'invoice:awaiting',
        kind: 'invoice',
        title: `Approve ${inboxKpis.awaitingApprovalCount} ${inboxKpis.awaitingApprovalCount === 1 ? 'invoice' : 'invoices'}`,
        meta: 'OCR done · prices flow to recipes on approve',
        suggested: 'LATER',
        hint: { value: String(inboxKpis.awaitingApprovalCount), sub: 'pending', tint: 'warn' },
        href: '/invoices',
        ctaLabel: 'Open',
      })
    }

    if (priceAlertCount > 0) {
      out.push({
        id: 'price:alerts',
        kind: 'price',
        title: `Review ${priceAlertCount} price ${priceAlertCount === 1 ? 'alert' : 'alerts'}`,
        meta: 'Cost moved — check menu pricing before service',
        suggested: 'LATER',
        hint: { value: String(priceAlertCount), sub: 'alerts', tint: 'warn' },
        href: '/signals',
        ctaLabel: 'Review',
      })
    }

    const lastFinal = countSessions
      .filter(s => s.status === 'FINALIZED' && s.finalizedAt)
      .sort((a, b) => new Date(b.finalizedAt!).getTime() - new Date(a.finalizedAt!).getTime())[0]
    const daysSince = lastFinal
      ? Math.floor((Date.now() - new Date(lastFinal.finalizedAt!).getTime()) / 86_400_000)
      : null
    if (daysSince === null || daysSince > 4) {
      out.push({
        id: 'count:stale',
        kind: 'count',
        title: daysSince === null ? 'Run your first count' : 'Schedule a partial count',
        meta: daysSince === null ? 'No counts yet — theoretical is unverified' : `Last count ${daysSince}d ago · drift widening`,
        suggested: 'LATER',
        hint: { value: daysSince === null ? '—' : `${daysSince}d`, sub: 'stale', tint: 'warn' },
        href: '/count',
        ctaLabel: 'Count',
      })
    }

    for (const c of custom) {
      out.push({
        id: c.id,
        kind: 'custom',
        title: c.title,
        meta: 'Added by you',
        suggested: 'SOON',
        ctaLabel: undefined,
      })
    }

    return out
  }, [prepItems, dashboard, inboxKpis, priceAlertCount, countSessions, custom])

  // Resolve effective priority: user override wins, else system suggestion.
  const priorityOf = useCallback(
    (c: Candidate): Priority => states[c.id]?.priority ?? c.suggested,
    [states],
  )
  const isDone = useCallback((id: string) => states[id]?.done ?? false, [states])

  const setPriority = useCallback((c: Candidate, priority: Priority) => {
    setStates(prev => ({ ...prev, [c.id]: { priority, done: prev[c.id]?.done ?? false } }))
  }, [])

  const toggleDone = useCallback((c: Candidate) => {
    setStates(prev => {
      const cur = prev[c.id] ?? { priority: c.suggested, done: false }
      return { ...prev, [c.id]: { ...cur, done: !cur.done } }
    })
  }, [])

  const addCustom = useCallback((title: string) => {
    const t = title.trim()
    if (!t) return
    const id = `custom:${slug(t)}-${t.length}-${candidates.length}`
    setCustom(prev => [...prev, { id, title: t }])
    setStates(prev => ({ ...prev, [id]: { priority: 'SOON', done: false } }))
  }, [candidates.length])

  const resetDay = useCallback(() => {
    setStates({})
    setCustom([])
  }, [])

  // ── Derived: lanes + readiness ────────────────────────────────────────────
  const onList = useMemo(
    () => candidates.filter(c => priorityOf(c) !== 'OFF'),
    [candidates, priorityOf],
  )
  const offList = useMemo(
    () => candidates.filter(c => priorityOf(c) === 'OFF'),
    [candidates, priorityOf],
  )

  const lanes = useMemo(() => {
    return LANES.map(lane => ({
      ...lane,
      items: onList
        .filter(c => priorityOf(c) === lane.key)
        .sort((a, b) => {
          // done sinks; then by kind weight; then title
          const da = isDone(a.id) ? 1 : 0, db = isDone(b.id) ? 1 : 0
          if (da !== db) return da - db
          return a.title.localeCompare(b.title)
        }),
    }))
  }, [onList, priorityOf, isDone])

  // Blocking = everything that must happen before doors (NOW + SOON).
  const blocking = useMemo(
    () => onList.filter(c => priorityOf(c) === 'NOW' || priorityOf(c) === 'SOON'),
    [onList, priorityOf],
  )
  const blockingDone = blocking.filter(c => isDone(c.id)).length
  const ready = blocking.length > 0 ? blockingDone === blocking.length : onList.length === 0
  const pct = blocking.length > 0 ? Math.round((blockingDone / blocking.length) * 100) : 100

  const firstName = user?.name?.split(' ')[0] ?? user?.email?.split('@')[0] ?? 'chef'
  const cutoff = nextServiceCutoff(new Date())
  const remMs = cutoff.getTime() - Date.now()
  const remH = Math.max(0, Math.floor(remMs / 3_600_000))
  const remM = Math.max(0, Math.floor((remMs % 3_600_000) / 60_000))

  return (
    <>
      <SubNav
        tabs={[
          { href: '/pass', label: 'Pass', icon: <Sun size={14} /> },
          { href: '/preshift', label: 'Pre-shift', icon: <Flame size={14} /> },
          { href: '/prep', label: 'Prep', icon: <ChefHat size={14} /> },
          { href: '/count', label: 'Count', icon: <ClipboardList size={14} /> },
        ]}
      />

      <div className="p-4 md:p-6 md:px-8 max-w-7xl mx-auto w-full">
        <PageHead
          crumbs={<><Clock size={12} /> TODAY / PRE-SHIFT · {fmtCrumbDate(new Date())}</>}
          title={<>Set the line, <em className="not-italic text-gold-2">{firstName}</em>.</>}
          sub={<>
            Doors in <b>{remH}h {remM}m</b> · <b>{onList.length}</b> on the list
            {blocking.length > 0 && <> · <b className={ready ? 'text-green-text' : 'text-red-text'}>{blockingDone}/{blocking.length}</b> before-doors done</>}
          </>}
          actions={
            <>
              <button
                onClick={resetDay}
                className="inline-flex items-center gap-1.5 border border-line bg-paper text-ink-2 px-3.5 py-[9px] rounded-[9px] text-[13px] font-medium hover:border-ink-3 transition-colors"
              >
                <RotateCcw size={13} className="text-ink-3" /> Reset
              </button>
              <Link
                href="/pass"
                aria-disabled={!ready}
                className={`inline-flex items-center gap-1.5 px-4 py-[9px] rounded-[9px] text-[13px] font-medium transition-colors ${
                  ready
                    ? 'bg-ink text-paper hover:bg-[#18181b]'
                    : 'bg-bg-2 text-ink-4 pointer-events-none border border-line'
                }`}
              >
                <ArrowRight size={13} className={ready ? 'text-gold' : 'text-ink-4'} />
                {ready ? 'Open service' : 'Finish the list'}
              </Link>
            </>
          }
        />

        {/* Readiness hero */}
        <ReadinessBar
          ready={ready}
          pct={pct}
          done={blockingDone}
          total={blocking.length}
          empty={onList.length === 0 && loaded}
        />

        {/* Add a task */}
        <AddTask onAdd={addCustom} />

        {/* Lanes */}
        <div className="grid gap-5 mt-5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
          {lanes.map(lane => (
            <Lane
              key={lane.key}
              lane={lane}
              priorityOf={priorityOf}
              isDone={isDone}
              onSetPriority={setPriority}
              onToggle={toggleDone}
              loaded={loaded}
            />
          ))}
        </div>

        {/* Off the list */}
        {offList.length > 0 && (
          <OffList
            items={offList}
            onSetPriority={setPriority}
          />
        )}

        <div className="mt-6 flex justify-between font-mono text-[10.5px] text-ink-3 tracking-wide">
          <span>YOUR LIST RESETS AT MIDNIGHT · SAVED ON THIS DEVICE</span>
          <span>SET A PRIORITY TO PUT A TASK ON THE LINE</span>
        </div>
      </div>
    </>
  )
}

// ── Sub-components (module scope — never remount on render) ──────────────────

function ReadinessBar({ ready, pct, done, total, empty }: {
  ready: boolean; pct: number; done: number; total: number; empty: boolean
}) {
  if (empty) {
    return (
      <div className="bg-ink text-paper rounded-[12px] p-5 mb-5 flex items-center gap-4">
        <span className="w-2.5 h-2.5 rounded-full bg-green shrink-0" />
        <div>
          <div className="text-[15px] font-semibold tracking-[-0.015em]">Nothing on the list yet</div>
          <div className="text-[12.5px] text-zinc-400 tracking-[-0.005em] mt-0.5">
            Set a priority on the suggestions below — or add your own — to build tonight&apos;s pre-shift.
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className="bg-ink text-paper rounded-[12px] p-5 mb-5">
      <div className="flex items-center justify-between gap-4 mb-3 flex-wrap">
        <div className="flex items-center gap-2.5">
          <span className={`w-2.5 h-2.5 rounded-full ${ready ? 'bg-green' : 'bg-gold'}`} />
          <span className="text-[15px] font-semibold tracking-[-0.015em]">
            {ready ? 'Ready for service' : 'Building toward service'}
          </span>
        </div>
        <span className="font-mono text-[11px] text-zinc-400 tracking-[0]">
          {total > 0 ? <><b className="text-paper">{done}</b> / {total} before-doors done</> : 'no before-doors tasks'}
        </span>
      </div>
      <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${ready ? 'bg-green' : 'bg-gold'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

function AddTask({ onAdd }: { onAdd: (title: string) => void }) {
  const [value, setValue] = useState('')
  const submit = () => { onAdd(value); setValue('') }
  return (
    <div className="flex items-center gap-2 bg-paper border border-line rounded-[12px] px-3.5 py-2.5">
      <Plus size={15} className="text-ink-3 shrink-0" />
      <input
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') submit() }}
        placeholder="Add your own pre-shift task — e.g. set up dessert station, brief the team…"
        className="flex-1 bg-transparent text-[13.5px] text-ink placeholder:text-ink-4 outline-none tracking-[-0.005em]"
      />
      <button
        onClick={submit}
        disabled={!value.trim()}
        className="font-mono text-[11px] px-3 py-1.5 rounded-full bg-ink text-paper font-medium hover:bg-[#27272a] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Add
      </button>
    </div>
  )
}

function Lane({ lane, priorityOf, isDone, onSetPriority, onToggle, loaded }: {
  lane: { key: Exclude<Priority, 'OFF'>; label: string; blurb: string; dot: string; items: Candidate[] }
  priorityOf: (c: Candidate) => Priority
  isDone: (id: string) => boolean
  onSetPriority: (c: Candidate, p: Priority) => void
  onToggle: (c: Candidate) => void
  loaded: boolean
}) {
  const doneCount = lane.items.filter(c => isDone(c.id)).length
  return (
    <section className="bg-paper border border-line rounded-[12px] overflow-hidden flex flex-col">
      <header className="px-[18px] py-3 border-b border-line bg-bg-2">
        <h3 className="text-[13px] font-semibold tracking-[-0.01em] flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${lane.dot}`} />
          {lane.label}
          <span className="font-mono text-[10.5px] text-ink-3 font-normal ml-auto">
            {doneCount}/{lane.items.length}
          </span>
        </h3>
        <p className="font-mono text-[10px] text-ink-3 mt-1 tracking-[0]">{lane.blurb}</p>
      </header>
      <div className="flex-1">
        {lane.items.length === 0 ? (
          <p className="text-[12.5px] text-ink-3 px-[18px] py-6 text-center">
            {loaded ? 'Nothing here.' : 'Loading…'}
          </p>
        ) : lane.items.map(c => (
          <TaskRow
            key={c.id}
            c={c}
            done={isDone(c.id)}
            priority={priorityOf(c)}
            onSetPriority={onSetPriority}
            onToggle={onToggle}
          />
        ))}
      </div>
    </section>
  )
}

const KIND_ICON: Record<TaskKind, typeof ClipboardList> = {
  prep: ChefHat,
  restock: Package,
  invoice: Mail,
  price: AlertTriangle,
  count: Activity,
  custom: ClipboardList,
}

function TaskRow({ c, done, priority, onSetPriority, onToggle }: {
  c: Candidate
  done: boolean
  priority: Priority
  onSetPriority: (c: Candidate, p: Priority) => void
  onToggle: (c: Candidate) => void
}) {
  const Icon = KIND_ICON[c.kind]
  const hintTint = c.hint?.tint === 'bad' ? 'text-red-text'
    : c.hint?.tint === 'warn' ? 'text-gold-2'
    : c.hint?.tint === 'ok' ? 'text-green-text' : 'text-ink-3'
  return (
    <div className={`px-[18px] py-3 border-b border-line last:border-0 transition-colors ${done ? 'bg-bg-2/40' : ''}`}>
      <div className="flex items-start gap-3">
        <button
          onClick={() => onToggle(c)}
          aria-pressed={done}
          aria-label={done ? 'Mark not done' : 'Mark done'}
          className={`mt-0.5 w-[22px] h-[22px] rounded-[7px] border grid place-items-center shrink-0 transition-colors ${
            done ? 'bg-green border-green text-paper' : 'border-line-2 text-transparent hover:border-ink-3'
          }`}
        >
          <Check size={14} strokeWidth={3} />
        </button>

        <div className="min-w-0 flex-1">
          <div className={`text-[13.5px] font-medium tracking-[-0.005em] flex items-center gap-1.5 ${done ? 'text-ink-3 line-through' : 'text-ink'}`}>
            <Icon size={13} className="text-ink-4 shrink-0" />
            <span className="truncate">{c.title}</span>
          </div>
          <div className="font-mono text-[10.5px] text-ink-3 mt-1 tracking-[0]">{c.meta}</div>
        </div>

        {c.hint && !done && (
          <div className={`text-right font-mono text-[12px] font-semibold tracking-[-0.01em] shrink-0 ${hintTint}`}>
            {c.hint.value}
            <small className="block font-normal text-ink-3 font-mono text-[10px] mt-0.5">{c.hint.sub}</small>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 mt-2.5 pl-[34px]">
        <PriorityPicker value={priority} onChange={p => onSetPriority(c, p)} />
        {c.href && (
          <Link
            href={c.href}
            className="ml-auto font-mono text-[10.5px] text-gold-2 border-b border-dashed border-current hover:text-gold whitespace-nowrap"
          >
            {c.ctaLabel ?? 'Open'} →
          </Link>
        )}
      </div>
    </div>
  )
}

const PICKER_OPTIONS: { key: Priority; label: string; active: string }[] = [
  { key: 'NOW',   label: 'Now',    active: 'bg-red text-paper border-red' },
  { key: 'SOON',  label: 'Doors',  active: 'bg-gold text-paper border-gold' },
  { key: 'LATER', label: 'If time', active: 'bg-green text-paper border-green' },
  { key: 'OFF',   label: 'Off',    active: 'bg-ink text-paper border-ink' },
]

function PriorityPicker({ value, onChange }: { value: Priority; onChange: (p: Priority) => void }) {
  return (
    <div className="inline-flex rounded-[8px] border border-line overflow-hidden">
      {PICKER_OPTIONS.map((opt, i) => {
        const active = value === opt.key
        return (
          <button
            key={opt.key}
            onClick={() => onChange(opt.key)}
            aria-pressed={active}
            className={`font-mono text-[10px] uppercase tracking-[0.02em] px-2 py-1 transition-colors ${
              i > 0 ? 'border-l border-line' : ''
            } ${active ? opt.active : 'bg-paper text-ink-3 hover:text-ink hover:bg-bg-2'}`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

function OffList({ items, onSetPriority }: {
  items: Candidate[]; onSetPriority: (c: Candidate, p: Priority) => void
}) {
  return (
    <section className="bg-paper border border-line rounded-[12px] overflow-hidden mt-5">
      <header className="px-[18px] py-3 border-b border-line bg-bg-2">
        <h3 className="text-[13px] font-semibold tracking-[-0.01em] flex items-center gap-2 text-ink-3">
          <span className="w-2 h-2 rounded-full bg-ink-4" />
          Off the list
          <span className="font-mono text-[10.5px] font-normal ml-auto">{items.length}</span>
        </h3>
      </header>
      {items.map(c => {
        const Icon = KIND_ICON[c.kind]
        return (
          <div key={c.id} className="flex items-center gap-3 px-[18px] py-2.5 border-b border-line last:border-0">
            <Icon size={13} className="text-ink-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] text-ink-3 tracking-[-0.005em] truncate">{c.title}</div>
            </div>
            <button
              onClick={() => onSetPriority(c, 'SOON')}
              className="font-mono text-[10.5px] text-gold-2 border-b border-dashed border-current hover:text-gold whitespace-nowrap shrink-0"
            >
              Put back →
            </button>
          </div>
        )
      })}
    </section>
  )
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function fmtQty(n: number): string {
  return n % 1 === 0 ? n.toFixed(0) : n.toFixed(1)
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32)
}

function nextServiceCutoff(d: Date): Date {
  const cutoff = new Date(d)
  if (d.getHours() < 17) {
    cutoff.setHours(17, 0, 0, 0)
  } else {
    cutoff.setDate(d.getDate() + 1)
    cutoff.setHours(11, 0, 0, 0)
  }
  return cutoff
}

function fmtCrumbDate(d: Date): string {
  return d.toLocaleString('en-US', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).toUpperCase()
}
