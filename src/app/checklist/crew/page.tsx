'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import type { Role } from '@prisma/client'
import { useUser } from '@/contexts/UserContext'
import { useToast } from '@/components/Toast'
import { atLeast } from '@/lib/roles'
import type { CrewStatus } from '@/lib/pin/crew-status'

// /checklist/crew — MANAGER+ "Crew sign-in". Phones waiting for an OK come
// first (each with the pair code the cook's phone shows), then every active
// cook with their sign-in status; a row opens to list that cook's phones.
// Phones are OK'd only here, from the manager's own signed-in session.
// Mobile first: one fluid column, capped at 640 px on a desktop.

const POLL_PENDING_MS = 10_000
const POLL_IDLE_MS = 60_000

type Pending = {
  id: string
  cookName: string
  label: string | null
  createdAt: string
  pairCode: string
  /** Other cooks already asking or OK'd on this same phone. */
  sharedWith: string[]
  /** Over 24 h old: can't be OK'd until the cook asks again. */
  stale: boolean
}
type DeviceStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'REVOKED'
type Device = {
  id: string
  label: string | null
  status: DeviceStatus
  createdAt: string
  lastUsedAt: string | null
  approvedByName: string | null
  pairCode: string
  sharedWith: string[]
}
type CrewRow = {
  cookId: string
  name: string
  station: string | null
  status: CrewStatus
  blocked: 'MANAGER' | 'SWITCHED_OFF' | null
  devices: Device[]
}
type CrewView = { pending: Pending[]; crew: CrewRow[] }
type Action = 'approve' | 'reject' | 'revoke'

type Result<T> = { ok: true; data: T } | { ok: false; error: string; status: number }

async function call<T>(url: string, init?: RequestInit): Promise<Result<T>> {
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      ...init,
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) return { ok: false, status: res.status, error: (data && typeof data.error === 'string' && data.error) || 'Could not save — try again.' }
    return { ok: true, data: data as T }
  } catch {
    return { ok: false, status: 0, error: 'No connection — try again.' }
  }
}

// ── Formatting ─────────────────────────────────────────────────────────────

/** 'just now' · '2 min ago' · '3 h ago' · '4 days ago'. */
function ago(iso: string, now: number): string {
  const min = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000))
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.floor(h / 24)
  return `${d} ${d === 1 ? 'day' : 'days'} ago`
}

const firstWord = (name: string) => name.trim().split(/\s+/)[0] || name

/** "Alex Lo" → "Alex L." — short enough to list several on one line. */
function shortName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : name.trim()
}

/** "Turn this phone down? Sam won't be able to ask from it again." */
const rejectQuestion = (cookName: string) => `Turn this phone down? ${firstWord(cookName)} won’t be able to ask from it again.`

function initials(name: string): string {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('')
}

const PILL: Record<CrewStatus['tone'], string> = {
  green: 'bg-green-soft text-green-text',
  gold: 'bg-gold-soft text-gold-2',
  grey: 'bg-bg-2 text-ink-2',
  red: 'bg-red-soft text-red-text',
}

const DEVICE_PILL: Record<DeviceStatus, { label: string; cls: string }> = {
  APPROVED: { label: 'OK’D', cls: PILL.green },
  PENDING: { label: 'WAITING', cls: PILL.gold },
  REJECTED: { label: 'NOT THEM', cls: PILL.red },
  REVOKED: { label: 'REMOVED', cls: PILL.grey },
}

function crewSub(c: CrewRow): string {
  const parts = [c.station || null]
  if (c.status.phones > 0) parts.push(`${c.status.phones} ${c.status.phones === 1 ? 'phone' : 'phones'}`)
  if (c.status.label === 'NO PIN') parts.push('no clock-in number')
  return parts.filter(Boolean).join(' · ') || '—'
}

// ── Pieces (module scope) ─────────────────────────────────────────────────

const OUTLINE_BTN = 'min-h-[44px] rounded-[9px] border border-line-2 bg-paper text-[13px] font-medium text-ink-2 disabled:opacity-50'

/** A yes/no asked in place before a permanent change (turn down, remove). */
function InlineConfirm({
  question,
  cancelLabel,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  question: string
  cancelLabel: string
  confirmLabel: string
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="rounded-[10px] bg-bg-2 px-3 py-3 flex flex-col gap-2.5">
      <p className="m-0 text-[13px] leading-[1.45] text-ink-2">{question}</p>
      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={onCancel} className={`flex-1 ${OUTLINE_BTN}`}>
          {cancelLabel}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className="flex-1 min-h-[44px] rounded-[9px] bg-red text-[13px] font-semibold text-paper disabled:opacity-50"
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  )
}

function PendingCard({
  p,
  now,
  busy,
  confirming,
  onAsk,
  onCancel,
  onAct,
}: {
  p: Pending
  now: number
  busy: boolean
  confirming: boolean
  onAsk: () => void
  onCancel: () => void
  onAct: (action: Action) => void
}) {
  return (
    <section aria-label={`${p.cookName} wants to sign in`} className="bg-paper border border-line rounded-[14px] px-4 py-3.5 flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="flex-none w-10 h-10 rounded-full bg-ink text-paper grid place-items-center font-mono text-[13px] font-semibold">
          {initials(p.cookName)}
        </span>
        <span className="flex-1 min-w-0 flex flex-col gap-0.5">
          <span className="text-[14.5px] font-semibold tracking-[-0.015em]">{p.cookName} wants to sign in</span>
          <span className="font-mono text-[10.5px] text-ink-3">{p.label || 'Phone'} · {ago(p.createdAt, now)}</span>
        </span>
        <span className="flex-none flex flex-col items-end gap-0.5">
          <span className="font-mono text-[9.5px] tracking-[0.08em] text-ink-3">CODE</span>
          <span className="font-mono text-[24px] leading-none font-semibold tracking-[0.1em] text-ink">{p.pairCode}</span>
        </span>
      </div>
      <p className="m-0 text-[12.5px] leading-[1.4] text-ink-3">Check the code on their phone matches before you OK it.</p>
      {p.sharedWith.length > 0 && (
        <p className="m-0 text-[12.5px] leading-[1.4] font-medium text-gold-2">
          Same phone as {p.sharedWith.map(shortName).join(', ')}
        </p>
      )}
      {confirming ? (
        <InlineConfirm
          question={rejectQuestion(p.cookName)}
          cancelLabel="Cancel"
          confirmLabel="Turn it down"
          busy={busy}
          onCancel={onCancel}
          onConfirm={() => onAct('reject')}
        />
      ) : (
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={onAsk} className={`flex-1 ${OUTLINE_BTN}`}>
            Not them
          </button>
          {p.stale ? (
            // Past 24 h the server won't OK it; the cook's next "Yes, it's me" restarts it.
            <span className="flex-[2] min-h-[44px] rounded-[9px] bg-bg-2 px-3 font-mono text-[10.5px] text-ink-3 inline-flex items-center justify-center text-center">
              TOO OLD — ask them to try again
            </span>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => onAct('approve')}
              className="flex-[2] min-h-[44px] rounded-[9px] bg-gold text-[13px] font-semibold text-ink disabled:opacity-50"
            >
              OK this phone
            </button>
          )}
        </div>
      )}
    </section>
  )
}

function PhoneRow({
  d,
  cookName,
  now,
  busy,
  confirming,
  onAsk,
  onCancel,
  onAct,
}: {
  d: Device
  cookName: string
  now: number
  busy: boolean
  confirming: boolean
  onAsk: () => void
  onCancel: () => void
  onAct: (action: Action) => void
}) {
  const pill = DEVICE_PILL[d.status]
  const meta = [
    d.lastUsedAt ? `last used ${ago(d.lastUsedAt, now)}` : d.status === 'APPROVED' ? 'not used yet' : `asked ${ago(d.createdAt, now)}`,
    d.status === 'APPROVED' && d.approvedByName ? `OK’d by ${d.approvedByName}` : null,
    `code ${d.pairCode}`,
  ].filter(Boolean).join(' · ')
  return (
    <li className="py-2.5 border-t border-bg-2 first:border-t-0 flex flex-col gap-2">
      <div className="flex items-center gap-2.5">
        <span className="flex-1 min-w-0 flex flex-col gap-0.5">
          <span className="text-[13.5px] font-medium text-ink-2">{d.label || 'Phone'}</span>
          <span className="font-mono text-[10.5px] text-ink-3">{meta}</span>
        </span>
        {d.sharedWith.length > 0 && (
          <span
            title={`Same phone as ${d.sharedWith.map(shortName).join(', ')}`}
            className={`flex-none font-mono text-[10px] font-medium px-[9px] py-[3px] rounded-full whitespace-nowrap ${PILL.gold}`}
          >
            SHARED
          </span>
        )}
        <span className={`flex-none font-mono text-[10px] font-medium px-[9px] py-[3px] rounded-full whitespace-nowrap ${pill.cls}`}>{pill.label}</span>
      </div>
      {d.status === 'APPROVED' && (confirming ? (
        <InlineConfirm
          question="Remove this phone? They’ll need a manager’s OK to sign in on it again."
          cancelLabel="Keep it"
          confirmLabel="Remove"
          busy={busy}
          onCancel={onCancel}
          onConfirm={() => onAct('revoke')}
        />
      ) : (
        <button type="button" disabled={busy} onClick={onAsk} className={`self-start px-3.5 ${OUTLINE_BTN}`}>
          Remove phone
        </button>
      ))}
      {d.status === 'PENDING' && (confirming ? (
        <InlineConfirm
          question={rejectQuestion(cookName)}
          cancelLabel="Cancel"
          confirmLabel="Turn it down"
          busy={busy}
          onCancel={onCancel}
          onConfirm={() => onAct('reject')}
        />
      ) : (
        // A blocked cook's request isn't in the waiting list; it can still be turned down here.
        <button type="button" disabled={busy} onClick={onAsk} className={`self-start px-3.5 ${OUTLINE_BTN}`}>
          Not them
        </button>
      ))}
    </li>
  )
}

function CrewItem({
  c,
  open,
  now,
  busyId,
  confirmKey,
  onToggle,
  onAsk,
  onCancel,
  onAct,
}: {
  c: CrewRow
  open: boolean
  now: number
  busyId: string | null
  confirmKey: string | null
  onToggle: () => void
  onAsk: (key: string) => void
  onCancel: () => void
  onAct: (d: Device, action: Action) => void
}) {
  const hasApproved = c.devices.some(d => d.status === 'APPROVED')
  return (
    <div className="border-t border-bg-2 first:border-t-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="w-full flex items-center gap-2.5 px-4 py-[11px] min-h-[44px] text-left"
      >
        <span className="flex-1 min-w-0 flex flex-col gap-0.5">
          <span className="text-[14.5px] font-semibold tracking-[-0.015em] text-ink">{c.name}</span>
          <span className="font-mono text-[10.5px] text-ink-3">{crewSub(c)}</span>
        </span>
        <span className={`flex-none font-mono text-[10px] font-medium px-[9px] py-[3px] rounded-full whitespace-nowrap ${PILL[c.status.tone]}`}>
          {c.status.label}
        </span>
      </button>
      {open && (
        <div className="px-4 pb-3.5 flex flex-col gap-2">
          {c.status.label === 'EMAIL LOGIN' && (
            <p className="m-0 text-[13px] text-ink-3">Managers sign in with email and password.</p>
          )}
          {c.status.label === 'SWITCHED OFF' && (
            <p className="m-0 text-[13px] text-ink-3">Their login is switched off in People, so no phone can sign in.</p>
          )}
          {c.status.label === 'NO PIN' && (
            <p className="m-0 text-[13px] text-ink-3">No clock-in number in Toast yet, so there’s no PIN to sign in with.</p>
          )}
          {c.devices.length === 0 ? (
            c.status.label !== 'EMAIL LOGIN' && c.status.label !== 'NO PIN' && (
              <p className="m-0 font-mono text-[11px] text-ink-3">No phones yet.</p>
            )
          ) : (
            <ul className="m-0 p-0 list-none flex flex-col">
              {c.devices.map(d => (
                <PhoneRow
                  key={d.id}
                  d={d}
                  now={now}
                  busy={busyId === d.id}
                  cookName={c.name}
                  confirming={confirmKey === `row:${d.id}`}
                  onAsk={() => onAsk(`row:${d.id}`)}
                  onCancel={onCancel}
                  onAct={action => onAct(d, action)}
                />
              ))}
            </ul>
          )}
          {hasApproved && (
            <p className="m-0 text-[12.5px] leading-[1.4] text-ink-3">
              To lock someone out now, switch off their login in People.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function CrewSignInPage() {
  const { role } = useUser()
  const toast = useToast()

  const [view, setView] = useState<CrewView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [openId, setOpenId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  // Which inline confirm is open: `card:<id>` (waiting card) or `row:<id>` (crew row).
  const [confirmKey, setConfirmKey] = useState<string | null>(null)

  const allowed = !role || atLeast(role as Role, 'MANAGER')

  const loadSeq = useRef(0)
  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    const r = await call<CrewView>('/api/pin-devices')
    if (seq !== loadSeq.current) return // a newer load started; drop this reply
    if (!r.ok) { setLoadError(r.error); return }
    setLoadError(null)
    setNow(Date.now())
    setView(r.data)
  }, [])

  const hasPending = (view?.pending.length ?? 0) > 0

  // Poll: every 10 s while a phone is waiting, otherwise every 60 s; only while visible.
  useEffect(() => {
    if (!allowed) return
    const id = setInterval(() => { if (document.visibilityState === 'visible') load() }, hasPending ? POLL_PENDING_MS : POLL_IDLE_MS)
    const onVis = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis) }
  }, [allowed, hasPending, load])

  useEffect(() => {
    if (allowed) load()
  }, [allowed, load])

  const act = async (deviceId: string, action: Action) => {
    if (busyId) return
    setBusyId(deviceId)
    const r = await call<{ ok: true }>(`/api/pin-devices/${deviceId}`, {
      method: 'PATCH',
      body: JSON.stringify({ action }),
    })
    if (!r.ok) toast.show({ type: 'error', title: r.error })
    else if (action === 'approve') toast.show({ type: 'success', title: 'Phone OK’d' })
    else if (action === 'revoke') toast.show({ type: 'success', title: 'Phone removed' })
    setConfirmKey(null)
    // 409 (someone else got there first, or the request can't be OK'd): reload to show where it stands.
    await load()
    setBusyId(null)
  }

  // ── Derived ──────────────────────────────────────────────────────────────
  const pending = view?.pending ?? []
  const crew = view?.crew ?? []
  // "Set up" = has an OK'd phone; cooks who can never use a PIN (managers,
  // switched-off logins) are left out of both sides of the count.
  const eligible = crew.filter(c => !c.blocked)
  const setUp = eligible.filter(c => c.status.phones > 0).length
  const n = pending.length

  return (
    <div className="max-w-[640px] mx-auto w-full flex flex-col gap-3.5">
      <header className="flex items-center justify-between">
        <Link href="/checklist/today" className="text-[13px] text-ink-3 min-h-[44px] inline-flex items-center">‹ Today</Link>
      </header>
      <h1 className="m-0 text-[26px] leading-[1.1] font-semibold tracking-[-0.035em]">Crew sign-in</h1>
      {view && (
        <p className="m-0 text-[15px] leading-[1.45] text-ink-2">
          {n > 0 ? (
            <><b className="font-semibold text-ink">{n} {n === 1 ? 'phone' : 'phones'}</b> waiting for your OK. </>
          ) : (
            <>No phones waiting. </>
          )}
          <b className="font-mono font-semibold text-ink">{setUp} of {eligible.length}</b> cooks set up.
        </p>
      )}

      {!allowed ? (
        <div className="bg-paper border border-line rounded-[14px] p-4 text-[14px] text-ink-3">This page is for managers.</div>
      ) : !view && !loadError ? (
        <div className="bg-paper border border-line rounded-[14px] p-4 text-[14px] text-ink-3">Loading…</div>
      ) : !view ? (
        <div className="bg-paper border border-line rounded-[14px] p-4 flex flex-col gap-3">
          <p className="m-0 text-[14px] text-red-text">{loadError}</p>
          <button type="button" onClick={load} className="self-start min-h-[44px] px-4 rounded-[10px] border border-line-2 text-[13px] font-medium text-ink-2">Try again</button>
        </div>
      ) : (
        <>
          {loadError && (
            // A poll failed: keep the list on screen, but say it may be out of date.
            <div role="status" className="rounded-[10px] bg-gold-soft text-gold-2 px-3.5 py-2.5 text-[13px]">
              Couldn’t refresh — showing the last list.
            </div>
          )}
          {pending.map(p => (
            <PendingCard
              key={p.id}
              p={p}
              now={now}
              busy={busyId === p.id}
              confirming={confirmKey === `card:${p.id}`}
              onAsk={() => setConfirmKey(`card:${p.id}`)}
              onCancel={() => setConfirmKey(null)}
              onAct={action => act(p.id, action)}
            />
          ))}

          <section aria-label="Crew" className="bg-paper border border-line rounded-[14px] overflow-hidden">
            <div className="flex justify-between items-baseline px-4 py-3 border-b border-line">
              <span className="text-[13.5px] font-semibold tracking-[-0.01em]">Crew</span>
              <span className="font-mono text-[10.5px] text-ink-3">PIN FROM CLOCK-IN</span>
            </div>
            {crew.length === 0 ? (
              <p className="m-0 px-4 py-4 text-[14px] text-ink-3">No active cooks yet.</p>
            ) : crew.map(c => (
              <CrewItem
                key={c.cookId}
                c={c}
                open={openId === c.cookId}
                now={now}
                busyId={busyId}
                confirmKey={confirmKey}
                onToggle={() => { setOpenId(id => (id === c.cookId ? null : c.cookId)); setConfirmKey(null) }}
                onAsk={key => setConfirmKey(key)}
                onCancel={() => setConfirmKey(null)}
                onAct={(d, action) => act(d.id, action)}
              />
            ))}
          </section>
        </>
      )}
    </div>
  )
}
