'use client'
import { useEffect, useMemo, useState, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Clock, Sun, Activity, ChefHat, ClipboardList, Plus, Check,
  Thermometer, UtensilsCrossed, RotateCcw, ArrowRight, ArrowLeft, X, Pencil,
} from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { setScopeParams } from '@/lib/scope-params'
import { useNowMinute } from '@/components/prep/runsheet/useNowMinute'
import { serviceStatus, fmtDuration, formatServiceStatus, serviceCaption, type RcService } from '@/lib/service-hours'
import { SubNav } from '@/components/layout/SubNav'
import { PageHead } from '@/components/layout/PageHead'
import { computeDayMetrics, type TempUnit } from '@/components/temps/temp-utils'
import { SafetyTempsSummary } from '@/components/preshift/SafetyTempsSummary'
import { MGateBanner, MProgress, MSectionCard, MCheckRow, MSignoff } from '@/components/preshift/mobile'

// ── Types ─────────────────────────────────────────────────────────────────

type Tint = 'ok' | 'warn' | 'bad' | 'neutral'
type SectionKey = 'safety' | 'line' | 'service'

interface CheckItem {
  id: string
  section: SectionKey
  title: string
  meta?: string
  /** Optional red-bold fragment appended to meta (e.g. "0 / 10 kg — critical"). */
  metaAlert?: string
  /** Static right-side status (non-temp items). */
  right?: { value: string; sub?: string; tint?: Tint }
  /** Hard blocker — gates service until checked off. */
  blocker?: boolean
  custom?: boolean
}

interface PrepItem {
  id: string; name: string; unit: string; station?: string | null
  onHand: number; parLevel: number
  priority: '911' | 'NEEDED_TODAY' | 'LATER'
  isBlocked: boolean; blockedReason: string | null
}

// ── Section metadata ─────────────────────────────────────────────────────

const SECTIONS: { key: SectionKey; title: string; icon: typeof Thermometer }[] = [
  { key: 'safety',  title: 'Safety & temps',          icon: Thermometer },
  { key: 'line',    title: 'Line checks · mise ready', icon: UtensilsCrossed },
  { key: 'service', title: 'Service readiness',        icon: Clock },
]

// Generic opening checks — shipped as editable defaults.
const SAFETY_DEFAULTS: CheckItem[] = [
  { id: 'safety:probe',    section: 'safety', title: 'Probe thermometer calibrated', meta: 'ice / boil check · daily' },
  { id: 'safety:sanitiser', section: 'safety', title: 'Sanitiser buckets made & dated', meta: 'all stations' },
]

const SERVICE_DEFAULTS: CheckItem[] = [
  { id: 'service:86',       section: 'service', title: '86 board confirmed with floor', meta: 'agree off-menu items before doors' },
  { id: 'service:specials', section: 'service', title: 'Specials tasted & briefed to floor', meta: 'tonight’s additions' },
  { id: 'service:allergen', section: 'service', title: 'Allergen tickets reviewed', meta: 'coeliac · nut · shellfish' },
  { id: 'service:pos',      section: 'service', title: 'POS open & printers tested', meta: 'kitchen + bar dockets' },
  { id: 'service:room',     section: 'service', title: 'Dining room & patio set', meta: 'covers laid · stations stocked' },
]

// Fallback line checks when there's no live prep data.
const LINE_FALLBACK: CheckItem[] = [
  { id: 'line:grill',   section: 'line', title: 'Grill — protein portioned & labelled', meta: 'portion & date all proteins' },
  { id: 'line:larder',  section: 'line', title: 'Larder — salads & cold apps dressed', meta: 'cold section mise' },
  { id: 'line:sauces',  section: 'line', title: 'Sauces — bases reduced & held', meta: 'mother sauces on the pass' },
  { id: 'line:pastry',  section: 'line', title: 'Pastry — desserts plated & chilled', meta: 'sweet section ready' },
  { id: 'line:garnish', section: 'line', title: 'Garnish & pass mise stocked', meta: 'pick, herbs, finishing oils' },
]

// ── Page ─────────────────────────────────────────────────────────────────

export default function PreshiftPage() {
  const router = useRouter()
  const { activeRcId, activeRc, activeKind, activeLocationId } = useRc()

  const [prepItems, setPrepItems] = useState<PrepItem[]>([])
  const [loaded, setLoaded] = useState(false)

  const storageKey = useMemo(() => `preshift:${ymd(new Date())}:${activeRcId || 'all'}`, [activeRcId])
  const templateKey = useMemo(() => `preshift:template:${activeRcId || 'all'}`, [activeRcId])

  const [done, setDone] = useState<Record<string, boolean>>({})
  const [template, setTemplate] = useState<CheckItem[]>([])
  const [hydrated, setHydrated] = useState(false)
  const [tplHydrated, setTplHydrated] = useState(false)
  const [tempUnits, setTempUnits] = useState<TempUnit[]>([])

  // Hydrate per-day done-state.
  useEffect(() => {
    setHydrated(false)
    try {
      const raw = localStorage.getItem(storageKey)
      const p = raw ? JSON.parse(raw) : {}
      setDone(p.done ?? {})
    } catch { setDone({}) }
    setHydrated(true)
  }, [storageKey])

  // Hydrate the editable checklist template (persists across days; seeded from defaults).
  useEffect(() => {
    setTplHydrated(false)
    try {
      const raw = localStorage.getItem(templateKey)
      const p = raw ? JSON.parse(raw) : null
      setTemplate(p && Array.isArray(p.items) ? p.items : seedTemplate())
    } catch { setTemplate(seedTemplate()) }
    setTplHydrated(true)
  }, [templateKey])

  // Persist done-state (per day) and template (per RC).
  useEffect(() => {
    if (!hydrated) return
    try { localStorage.setItem(storageKey, JSON.stringify({ done })) } catch { /* noop */ }
  }, [done, hydrated, storageKey])
  useEffect(() => {
    if (!tplHydrated) return
    try { localStorage.setItem(templateKey, JSON.stringify({ items: template })) } catch { /* noop */ }
  }, [template, tplHydrated, templateKey])

  // Live prep.
  useEffect(() => {
    let cancelled = false
    fetch('/api/prep/items', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : [])
      .then(p => { if (!cancelled && Array.isArray(p)) setPrepItems(p) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [activeRcId])

  // Live temp units (mirror of the Temps page) for the safety gate.
  useEffect(() => {
    let cancelled = false
    const today = ymd(new Date())
    const p = new URLSearchParams({ date: today })
    setScopeParams(p, { activeKind, activeRcId, activeRc, activeLocationId })
    fetch(`/api/temps/units?${p.toString()}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : [])
      .then(d => { if (!cancelled && Array.isArray(d)) setTempUnits(d) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [activeKind, activeRcId, activeRc, activeLocationId])

  // ── Build the line-check items from prep ──────────────────────────────────
  const lineItems = useMemo<CheckItem[]>(() => {
    const active = prepItems.filter(p => p.priority !== 'LATER')
    if (active.length === 0) return LINE_FALLBACK
    return active.map(it => {
      const station = it.station ? `${it.station} — ` : ''
      const pct = it.parLevel > 0 ? it.onHand / it.parLevel : 1
      const is911 = it.priority === '911'
      const right: CheckItem['right'] = is911 || it.isBlocked
        ? { value: 'behind', sub: 'blocker', tint: 'bad' }
        : pct >= 1
          ? { value: 'ready', sub: 'on par', tint: 'ok' }
          : pct <= 0
            ? { value: 'behind', sub: 'blocker', tint: 'bad' }
            : { value: `${Math.round(pct * 100)}%`, sub: 'in progress', tint: 'warn' }
      const blocker = is911 || it.isBlocked || pct <= 0
      const metaAlert = blocker
        ? `${fmtQty(it.onHand)} / ${fmtQty(it.parLevel)} ${it.unit} — critical`
        : undefined
      return {
        id: `line:prep:${it.id}`,
        section: 'line' as const,
        title: `${station}${it.name}`,
        meta: it.isBlocked && it.blockedReason
          ? it.blockedReason
          : blocker ? undefined : `${fmtQty(it.onHand)} / ${fmtQty(it.parLevel)} ${it.unit} on hand`,
        metaAlert,
        right,
        blocker,
      }
    })
  }, [prepItems])

  // ── All items, grouped by section ─────────────────────────────────────────
  const itemsBySection = useMemo<Record<SectionKey, CheckItem[]>>(() => ({
    safety:  template.filter(c => c.section === 'safety'),
    line:    lineItems,
    service: template.filter(c => c.section === 'service'),
  }), [lineItems, template])

  const allItems = useMemo(
    () => SECTIONS.flatMap(s => itemsBySection[s.key]),
    [itemsBySection],
  )

  const isDone = useCallback((it: CheckItem) => !!done[it.id], [done])

  const isBlockingOpen = useCallback((it: CheckItem) => {
    if (isDone(it)) return false
    return !!it.blocker
  }, [isDone])

  // Temps gate: ready when every unit is logged today and none is out of range
  // (or there are no units configured yet).
  const tempMetrics = useMemo(() => computeDayMetrics(tempUnits), [tempUnits])
  const tempsReady = tempMetrics.total === 0
    ? true
    : tempMetrics.logged === tempMetrics.total && tempMetrics.flagged === 0

  // ── Derived totals (temps counts as one gate item) ─────────────────────────
  const blockers = allItems.filter(isBlockingOpen)
  const total = allItems.length + 1
  const doneCount = allItems.filter(isDone).length + (tempsReady ? 1 : 0)
  const blockersOpen = blockers.length + (tempsReady ? 0 : 1)
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0
  const ready = doneCount === total

  const carries = useMemo(
    () => allItems.filter(it => !isDone(it) && !isBlockingOpen(it) && it.right?.tint === 'warn'),
    [allItems, isDone, isBlockingOpen],
  )

  // ── Actions ───────────────────────────────────────────────────────────────
  const toggle = useCallback((it: CheckItem) => {
    setDone(prev => ({ ...prev, [it.id]: !prev[it.id] }))
  }, [])

  const addCheck = useCallback((section: SectionKey, title: string, blocker: boolean) => {
    const t = title.trim()
    if (!t) return
    const id = `tpl:${section}:${slug(t)}-${Date.now().toString(36)}`
    setTemplate(prev => [...prev, { id, section, title: t, meta: 'Added by you', blocker }])
  }, [])

  const deleteItem = useCallback((id: string) => {
    setTemplate(prev => prev.filter(c => c.id !== id))
    setDone(prev => { const n = { ...prev }; delete n[id]; return n })
  }, [])

  const editItem = useCallback((id: string, title: string) => {
    const t = title.trim()
    if (!t) return
    setTemplate(prev => prev.map(c => c.id === id ? { ...c, title: t } : c))
  }, [])

  const resetAll = useCallback(() => { setDone({}) }, [])

  const openService = useCallback(() => { if (ready) router.push('/pass') }, [ready, router])

  // ESC → back to Pass
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') router.push('/pass') }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [router])

  // `nowMin` from useNowMinute() (the hook /prep uses) so this page ticks instead of
  // only recomputing when something else happens to re-render it — /pass and /preshift
  // used to agree with /prep at mount and silently diverge a minute later.
  const { nowMin } = useNowMinute()
  // Null when no RC is active ("All"/Location scope) — that's "unknown", not "on-demand".
  // svcStatus.kind === 'none' only means something (no service window) once we actually
  // have a concrete RC's schedule to read.
  const status = activeRc ? serviceStatus((activeRc.services ?? []) as RcService[], nowMin, activeRc.prepLeadMinutes ?? null) : null
  // MProgress's badge is `{countdown}{countdownLabel ? ' · ' + countdownLabel : ''}` — it only
  // renders when `countdown` is truthy, so `underway` and the on-demand `none` state need
  // a non-null countdown too, or the badge silently disappears (and preshift stops agreeing
  // with prep/pass). `closed` is the one state where rendering nothing IS the answer.
  //
  // The compound "{name} · {next.name} in {duration}" text (the underway caption both
  // `countdownLabel` and `serviceName` need below) comes from service-hours.ts's
  // `serviceCaption` — it used to be hand-transcribed twice in this file, which is
  // exactly the kind of drift this branch is closing off. This if-chain still branches
  // on `status.kind` itself (rather than fully delegating) so the exhaustiveness guard
  // at the end is a real compile-time check in THIS file, not just inside the shared lib.
  const svcDisplay = useMemo(() => {
    if (!status) return { countdown: null as string | null, label: null as string | null, name: null as string | null, inService: false }
    if (status.kind === 'upcoming') {
      return { countdown: fmtDuration(status.minsUntil * 60_000), label: `to ${status.service.name}`, name: status.service.name, inService: false }
    }
    if (status.kind === 'underway') {
      const cap = serviceCaption(status)
      return { countdown: 'underway', label: cap, name: cap, inService: true }
    }
    if (status.kind === 'closed') {
      return { countdown: null, label: null, name: null, inService: false }
    }
    if (status.kind === 'none') {
      return { countdown: formatServiceStatus(status)?.lead ?? 'on-demand', label: null, name: null, inService: false }
    }
    const _never: never = status
    return _never
  }, [status])
  const serviceCountdown = svcDisplay.countdown
  const countdownLabel = svcDisplay.label
  // Desktop ProgressBand (below) wants the bare service name (or, for `underway`, the
  // compound "{name} · {next.name} in {duration}" caption above — NOT the bare name) +
  // in-service flag separately; it builds its own "to {name}" / "{name}" caption on top.
  const serviceName = svcDisplay.name
  const isInServiceNow = svcDisplay.inService

  return (
    <>
      <SubNav
        tabs={[
          { href: '/pass', label: 'Pass', icon: <Sun size={14} /> },
          { href: '/preshift', label: 'Pre-shift', icon: <Activity size={14} /> },
          { href: '/prep', label: 'Prep', icon: <ChefHat size={14} /> },
          { href: '/count', label: 'Count', icon: <ClipboardList size={14} /> },
        ]}
      />

      {/* ── Mobile (option A) ── */}
      <div className="md:hidden p-4 max-w-lg mx-auto w-full">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-xl font-bold text-ink tracking-[-0.02em]">Pre-shift</h1>
            <p className="font-mono text-[10.5px] text-ink-3 mt-0.5 uppercase tracking-[0.02em]">
              {new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} · Walk the line
            </p>
          </div>
          <button onClick={resetAll} className="font-mono text-[11px] text-ink-3 border border-line bg-paper rounded-full px-3 py-2">Reset</button>
        </div>

        <MGateBanner blockersOpen={blockersOpen} ready={ready} />
        <MProgress done={doneCount} total={total} pct={pct} countdown={serviceCountdown} countdownLabel={countdownLabel} />

        {SECTIONS.map(sec => {
          const items = itemsBySection[sec.key]
          const isSafety = sec.key === 'safety'
          const d = items.filter(isDone).length + (isSafety && tempsReady ? 1 : 0)
          const t = items.length + (isSafety ? 1 : 0)
          return (
            <MSectionCard key={sec.key} title={sec.title} done={d} total={t}>
              {isSafety && (
                <SafetyTempsSummary
                  logged={tempMetrics.logged}
                  total={tempMetrics.total}
                  flagged={tempMetrics.flagged}
                  blocking={!tempsReady}
                  onLogTemps={() => router.push('/temps')}
                />
              )}
              {items.map(it => (
                <MCheckRow
                  key={it.id}
                  title={it.title}
                  meta={it.meta}
                  metaAlert={it.metaAlert}
                  done={isDone(it)}
                  right={it.right?.value}
                  rightTint={it.right?.tint}
                  onToggle={() => toggle(it)}
                  onEdit={sec.key === 'line' ? undefined : (title) => editItem(it.id, title)}
                  onDelete={sec.key === 'line' ? undefined : () => deleteItem(it.id)}
                />
              ))}
            </MSectionCard>
          )
        })}

        <AddCheck onAdd={addCheck} />
        <div className="mt-3" />
        <MSignoff ready={ready} onOpen={openService} />
        <div className="h-6" />
      </div>

      <div className="hidden md:block p-4 md:p-6 md:px-8 max-w-7xl mx-auto w-full">
        <PageHead
          className="mb-5 items-center"
          crumbs={
            <Link href="/pass" className="inline-flex items-center gap-1.5 hover:text-ink transition-colors">
              <ArrowLeft size={12} /> BACK TO PASS
            </Link>
          }
          title={<>Pre-shift <em className="not-italic text-gold-2">check</em>.</>}
          sub={<>Walk the line, log temps, confirm the 86 board. <b>Service can&apos;t open</b> until every blocker clears.</>}
          actions={
            <>
              <button onClick={resetAll} className="inline-flex items-center gap-1.5 border border-line bg-paper text-ink-2 px-3.5 py-[9px] rounded-[9px] text-[13px] font-medium hover:border-ink-3 transition-colors">
                <RotateCcw size={13} className="text-ink-3" /> Reset
              </button>
            </>
          }
        />

        {/* Progress band */}
        <ProgressBand
          done={doneCount}
          total={total}
          pct={pct}
          blockersOpen={blockersOpen}
          lineCount={itemsBySection.line.length}
          serviceCountdown={serviceCountdown}
          serviceLabel={serviceName}
          isInService={isInServiceNow}
        />

        <AddCheck onAdd={addCheck} />

        <div className="grid gap-5 mt-5" style={{ gridTemplateColumns: '1fr 320px' }}>
          {/* Sections */}
          <div className="min-w-0">
            {SECTIONS.map(sec => {
              const items = itemsBySection[sec.key]
              const isSafety = sec.key === 'safety'
              const d = items.filter(isDone).length + (isSafety && tempsReady ? 1 : 0)
              const t = items.length + (isSafety ? 1 : 0)
              return (
                <Section key={sec.key} title={sec.title} Icon={sec.icon} done={d} total={t}>
                  {isSafety && (
                    <SafetyTempsSummary
                      logged={tempMetrics.logged}
                      total={tempMetrics.total}
                      flagged={tempMetrics.flagged}
                      blocking={!tempsReady}
                      onLogTemps={() => router.push('/temps')}
                    />
                  )}
                  {items.length === 0 && !isSafety ? (
                    <p className="text-[12.5px] text-ink-3 px-[18px] py-6 text-center">{loaded ? 'No checks here yet — add one above.' : 'Loading…'}</p>
                  ) : items.map(it => (
                    <CheckRow
                      key={it.id}
                      item={it}
                      done={isDone(it)}
                      blockingOpen={isBlockingOpen(it)}
                      onToggle={() => toggle(it)}
                      onEdit={sec.key === 'line' ? undefined : (title) => editItem(it.id, title)}
                      onDelete={sec.key === 'line' ? undefined : () => deleteItem(it.id)}
                    />
                  ))}
                </Section>
              )
            })}
          </div>

          {/* Sign-off rail */}
          <aside className="space-y-3.5">
            <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">Right rail · sign-off</div>

            <GateCard pct={pct} ready={ready} blockersOpen={blockersOpen} remaining={total - doneCount} onOpen={openService} />

            <RailCard title="Open blockers" count={blockersOpen}>
              {blockersOpen === 0 ? (
                <p className="text-[12.5px] text-green-text py-1">No blockers — line is clear.</p>
              ) : (
                <>
                  {!tempsReady && (
                    <div className="flex items-center gap-2.5 py-2 border-b border-dashed border-line last:border-0 text-[12.5px]">
                      <span className="w-[7px] h-[7px] rounded-full bg-red shrink-0" />
                      <span className="font-medium text-ink tracking-[-0.005em] truncate">Temperatures</span>
                      <span className="font-mono text-[10px] text-ink-3 ml-auto whitespace-nowrap">
                        {tempMetrics.flagged > 0 ? `${tempMetrics.flagged} out` : `${tempMetrics.total - tempMetrics.logged} to log`}
                      </span>
                    </div>
                  )}
                  {blockers.map(b => (
                    <div key={b.id} className="flex items-center gap-2.5 py-2 border-b border-dashed border-line last:border-0 text-[12.5px]">
                      <span className="w-[7px] h-[7px] rounded-full bg-red shrink-0" />
                      <span className="font-medium text-ink tracking-[-0.005em] truncate">{b.title}</span>
                      <span className="font-mono text-[10px] text-ink-3 ml-auto whitespace-nowrap">{b.right?.value ?? 'open'}</span>
                    </div>
                  ))}
                </>
              )}
            </RailCard>

            <RailCard title="Carries into tonight">
              {carries.length === 0 ? (
                <p className="text-[12.5px] text-ink-3 py-1">Nothing flagged — finish the list.</p>
              ) : carries.map(c => (
                <div key={c.id} className="flex items-center gap-2.5 py-2 border-b border-dashed border-line last:border-0 text-[12.5px]">
                  <span className="w-[7px] h-[7px] rounded-full bg-gold shrink-0" />
                  <span className="font-medium text-ink tracking-[-0.005em] truncate">{c.title}</span>
                  <span className="font-mono text-[10px] text-ink-3 ml-auto whitespace-nowrap">{c.right?.value}</span>
                </div>
              ))}
            </RailCard>
          </aside>
        </div>

        <div className="mt-5 flex justify-between font-mono text-[10.5px] text-ink-3 tracking-wide flex-wrap gap-2">
          <span>PRE-SHIFT IN PROGRESS · {doneCount} OF {total} CHECKS · SAVED ON THIS DEVICE</span>
          <span>↵ TOGGLE CHECK · ESC BACK TO PASS</span>
        </div>
      </div>
    </>
  )
}

// ── Sub-components (module scope) ────────────────────────────────────────────

function ProgressBand({ done, total, pct, blockersOpen, lineCount, serviceCountdown, serviceLabel, isInService }: {
  done: number; total: number; pct: number; blockersOpen: number; lineCount: number
  serviceCountdown: string | null; serviceLabel: string | null; isInService: boolean
}) {
  return (
    <div className="bg-paper border border-line rounded-[12px] px-[22px] py-[18px] flex items-center gap-6 flex-wrap">
      <div className="flex flex-col gap-[3px] shrink-0">
        <div className="text-[30px] font-semibold tracking-[-0.04em] leading-none">
          {done}<span className="text-ink-4 font-medium">/{total}</span>
        </div>
        <div className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.04em]">checks complete</div>
      </div>

      <div className="flex-1 flex flex-col gap-2.5 min-w-[260px]">
        <div className="h-2 rounded-full bg-bg-2 overflow-hidden">
          <div className={`h-full rounded-full transition-all duration-300 ${blockersOpen > 0 ? 'bg-red' : pct === 100 ? 'bg-green' : 'bg-gold'}`} style={{ width: `${pct}%` }} />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {blockersOpen > 0 && (
            <span className="inline-flex items-center gap-1.5 text-[12px] font-medium bg-red-soft border border-red/40 text-red-text px-2.5 py-[5px] rounded-full">
              <span className="w-[7px] h-[7px] rounded-full bg-red" /> <span className="font-mono font-semibold">{blockersOpen}</span> blocker{blockersOpen > 1 ? 's' : ''} open
            </span>
          )}
          <span className="inline-flex items-center gap-1.5 text-[12px] font-medium bg-bg border border-line text-ink-2 px-2.5 py-[5px] rounded-full">
            <span className="w-[7px] h-[7px] rounded-full bg-gold" /> <span className="font-mono font-semibold">{lineCount}</span> line checks
          </span>
          <span className="inline-flex items-center gap-1.5 text-[12px] font-medium bg-bg border border-line text-ink-2 px-2.5 py-[5px] rounded-full">
            <span className="w-[7px] h-[7px] rounded-full bg-blue" /> <span className="font-mono font-semibold">{total - done}</span> left
          </span>
        </div>
      </div>

      {/* serviceCountdown is null only when there's no active RC (All/Location scope) —
          render nothing rather than a misleading "on-demand"/"No window" placeholder.
          'on-demand' is itself a real value here (RC active, no service window). */}
      {serviceCountdown && (
        <div className="shrink-0 text-right border-l border-line pl-6">
          <div className="text-[22px] font-semibold tracking-[-0.03em] font-mono">
            {serviceCountdown}
          </div>
          <div className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.04em] mt-[3px]">
            {serviceCountdown === 'on-demand'
              ? 'no fixed service'
              : isInService
                ? serviceLabel ?? 'in service'
                : serviceLabel ? `to ${serviceLabel}` : 'to service'}
          </div>
        </div>
      )}
    </div>
  )
}

function AddCheck({ onAdd }: { onAdd: (section: SectionKey, title: string, blocker: boolean) => void }) {
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState<SectionKey>('safety')
  const [title, setTitle] = useState('')
  const [blocker, setBlocker] = useState(false)
  const submit = () => { onAdd(section, title, blocker); setTitle(''); setBlocker(false) }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="mt-4 inline-flex items-center gap-1.5 border border-line bg-paper text-ink-2 px-3.5 py-[9px] rounded-[9px] text-[13px] font-medium hover:border-ink-3 transition-colors">
        <Plus size={14} className="text-ink-3" /> Add check
      </button>
    )
  }
  return (
    <div className="mt-4 flex items-center gap-2 bg-paper border border-line rounded-[12px] px-3.5 py-2.5 flex-wrap">
      <select value={section} onChange={e => setSection(e.target.value as SectionKey)} className="bg-bg-2 border border-line rounded-[7px] text-[12.5px] text-ink-2 px-2 py-1.5 outline-none">
        {SECTIONS.filter(s => s.key !== 'line').map(s => <option key={s.key} value={s.key}>{s.title}</option>)}
      </select>
      <input
        autoFocus
        value={title}
        onChange={e => setTitle(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') setOpen(false) }}
        placeholder="What needs doing before service?"
        className="flex-1 min-w-[180px] bg-transparent text-[13.5px] text-ink placeholder:text-ink-4 outline-none tracking-[-0.005em]"
      />
      <button onClick={() => setBlocker(b => !b)} className={`font-mono text-[10px] uppercase tracking-[0.02em] px-2.5 py-1.5 rounded-full border transition-colors ${blocker ? 'bg-red text-paper border-red' : 'bg-paper text-ink-3 border-line hover:border-ink-3'}`}>
        Blocker
      </button>
      <button onClick={submit} disabled={!title.trim()} className="font-mono text-[11px] px-3 py-1.5 rounded-full bg-ink text-paper font-medium hover:bg-ink-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">Add</button>
      <button onClick={() => setOpen(false)} className="text-ink-3 hover:text-ink p-1"><X size={15} /></button>
    </div>
  )
}

function Section({ title, Icon, done, total, children }: {
  title: string; Icon: typeof Thermometer; done: number; total: number; children: React.ReactNode
}) {
  const complete = total > 0 && done === total
  return (
    <section className="bg-paper border border-line rounded-[12px] overflow-hidden mb-4">
      <header className="flex items-center justify-between px-[18px] py-[13px] border-b border-line bg-bg-2">
        <h3 className="text-[13.5px] font-semibold tracking-[-0.01em] flex items-center gap-2.5">
          <span className="w-6 h-6 rounded-[7px] bg-paper border border-line grid place-items-center text-ink-2"><Icon size={13} /></span>
          {title}
        </h3>
        <span className={`font-mono text-[10.5px] ${complete ? 'text-green-text' : 'text-ink-3'}`}>{done} / {total}</span>
      </header>
      {children}
    </section>
  )
}

function CheckRow({ item, done, blockingOpen, onToggle, onEdit, onDelete }: {
  item: CheckItem
  done: boolean
  blockingOpen: boolean
  onToggle: () => void
  onEdit?: (title: string) => void
  onDelete?: () => void
}) {
  const rightTint = (t?: Tint) =>
    t === 'bad' ? 'text-red-text' : t === 'warn' ? 'text-gold-2' : t === 'ok' ? 'text-green-text' : 'text-ink-3'
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.title)
  const editable = !!onEdit || !!onDelete
  const commit = () => { const t = draft.trim(); if (t) onEdit?.(t); setEditing(false) }

  return (
    <div
      className="grid grid-cols-[26px_1fr_auto] items-center gap-3.5 px-[18px] py-[13px] border-b border-line last:border-0 hover:bg-bg/60 transition-colors cursor-pointer group"
      onClick={() => { if (!editing) onToggle() }}
    >
      <div className={`w-[22px] h-[22px] rounded-[6px] border-[1.5px] grid place-items-center transition-all ${done ? 'bg-green border-green text-white' : 'border-line-2 text-transparent'}`}>
        <Check size={13} strokeWidth={3} />
      </div>

      <div className="min-w-0">
        <div className={`text-[14px] font-medium tracking-[-0.01em] flex items-center gap-1.5 ${done ? 'text-ink-3 line-through decoration-ink-4' : 'text-ink'}`}>
          {editing ? (
            <input
              autoFocus
              value={draft}
              onClick={e => e.stopPropagation()}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(item.title); setEditing(false) } }}
              onBlur={commit}
              className="flex-1 min-w-0 bg-bg border border-ink-3 rounded-[6px] px-2 py-0.5 text-[14px] text-ink outline-none"
            />
          ) : (
            <span className="truncate">{item.title}</span>
          )}
          {editable && !editing && (
            <span className="ml-1 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
              <button onClick={e => { e.stopPropagation(); setDraft(item.title); setEditing(true) }} className="text-ink-4 hover:text-ink" aria-label="Edit"><Pencil size={12} /></button>
              <button onClick={e => { e.stopPropagation(); onDelete?.() }} className="text-ink-4 hover:text-red-text" aria-label="Delete"><X size={12} /></button>
            </span>
          )}
        </div>
        {(item.meta || item.metaAlert) && !editing && (
          <div className="font-mono text-[10.5px] text-ink-3 mt-[3px] tracking-[0] flex items-center gap-1.5 flex-wrap">
            {item.meta}
            {item.meta && item.metaAlert && <span className="text-ink-4">·</span>}
            {item.metaAlert && <b className="text-red-text font-semibold">{item.metaAlert}</b>}
          </div>
        )}
      </div>

      {item.right ? (
        <div className={`text-right font-mono text-[11.5px] font-semibold tracking-[-0.01em] ${rightTint(item.right.tint)}`}>
          {item.right.value}
          {item.right.sub && <small className="block font-normal text-ink-3 text-[9.5px] mt-px">{item.right.sub}</small>}
        </div>
      ) : (
        <div className="text-right font-mono text-[11.5px] text-ink-3">{done ? '✓' : '—'}</div>
      )}
    </div>
  )
}

function GateCard({ pct, ready, blockersOpen, remaining, onOpen }: {
  pct: number; ready: boolean; blockersOpen: number; remaining: number; onOpen: () => void
}) {
  const C = 2 * Math.PI * 44
  const offset = C * (1 - pct / 100)
  const ringColor = ready ? '#16a34a' : blockersOpen > 0 ? '#dc2626' : '#d97706'
  const title = ready ? 'Ready for service' : blockersOpen > 0 ? 'Not ready' : 'Almost there'
  const sub = ready
    ? 'All checks signed off. Open the doors.'
    : blockersOpen > 0
      ? `${blockersOpen} blocker${blockersOpen > 1 ? 's' : ''} must clear before service can open.`
      : `${remaining} check${remaining > 1 ? 's' : ''} left — no blockers, finish the list.`

  return (
    <div className="bg-paper border border-line rounded-[12px] p-[18px] text-center">
      <div className="w-24 h-24 mx-auto mt-1 mb-3.5 grid place-items-center relative">
        <svg viewBox="0 0 100 100" width="96" height="96" className="absolute inset-0 -rotate-90">
          <circle cx="50" cy="50" r="44" fill="none" stroke="#f4f4f5" strokeWidth="8" />
          <circle cx="50" cy="50" r="44" fill="none" stroke={ringColor} strokeWidth="8" strokeLinecap="round"
            strokeDasharray={C.toFixed(2)} strokeDashoffset={offset.toFixed(2)} style={{ transition: 'stroke-dashoffset .3s ease, stroke .3s' }} />
        </svg>
        <div className="text-[26px] font-semibold tracking-[-0.04em]">{pct}<small className="text-[13px] text-ink-3">%</small></div>
      </div>
      <div className="text-[14px] font-semibold tracking-[-0.015em]">{title}</div>
      <div className="font-mono text-[10.5px] text-ink-3 mt-1 leading-[1.5]">{sub}</div>
      <button
        onClick={onOpen}
        disabled={!ready}
        className={`w-full mt-4 py-3 rounded-[9px] text-[13.5px] font-semibold tracking-[-0.01em] inline-flex items-center justify-center gap-2 transition-all ${
          ready
            ? 'bg-green border border-green text-white hover:bg-green-text cursor-pointer shadow-[0_8px_20px_-8px_rgba(22,163,74,0.5)]'
            : 'bg-bg-2 border border-line text-ink-4 cursor-not-allowed'
        }`}
      >
        <ArrowRight size={14} strokeWidth={2.5} /> Open service
      </button>
    </div>
  )
}

function RailCard({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <div className="bg-paper border border-line rounded-[12px] p-[16px_18px]">
      <h4 className="text-[13px] font-semibold tracking-[-0.01em] flex items-center gap-2 mb-3">
        {title}
        {count !== undefined && <span className="font-mono text-[10px] text-ink-3 font-normal ml-auto">{count}</span>}
      </h4>
      <div>{children}</div>
    </div>
  )
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function seedTemplate(): CheckItem[] {
  return [...SAFETY_DEFAULTS, ...SERVICE_DEFAULTS].map(it => ({ ...it }))
}
function fmtQty(n: number): string { return n % 1 === 0 ? n.toFixed(0) : n.toFixed(1) }
function ymd(d: Date): string { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
function slug(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) }
