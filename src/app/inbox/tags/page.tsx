'use client'
import { useCallback, useEffect, useState } from 'react'
import type { Role } from '@prisma/client'
import { useUser } from '@/contexts/UserContext'
import { useToast } from '@/components/Toast'
import { atLeast } from '@/lib/roles'
import type { TagLite } from '@/lib/inbox/rules'
import { call } from '@/components/inbox/api'
import { TagDot } from '@/components/inbox/TagChips'
import { TagSheet, type TagDraft } from '@/components/inbox/TagSheet'
import { SectionTabs } from '@/components/nav/SectionTabs'
import { inboxTabs } from '@/lib/section-tabs'

// /inbox/tags — MANAGER+: add, rename, recolour and remove Inbox tags, and say
// which tag each kind of checklist flag lands in. One column on every screen.

type ManagedTag = TagLite & { openCount?: number }
type Reason = 'BROKEN' | 'RAN_OUT' | 'OTHER'
type Routes = Record<Reason, string | null>

const REASONS: { reason: Reason; label: string }[] = [
  { reason: 'BROKEN', label: 'Broken' },
  { reason: 'RAN_OUT', label: 'Ran out' },
  { reason: 'OTHER', label: 'Other' },
]

const BUILT_IN_META: Record<string, string> = {
  FOOD_SAFETY: 'TEMPS + OUT-OF-RANGE READINGS',
  CHECKLISTS: 'STATIONS NOT STARTED / NOT SIGNED',
  PREP: 'CRITICAL PREP + DEADLINES',
  STOCK: 'RUNNING LOW, RAN OUT, COUNT AGE',
  MONEY: 'PRICES, INVOICES · MANAGERS ONLY',
  TEAM: 'PHONES TO OK, MISSED SIGN-OFFS',
}

const CARD = 'bg-paper border border-line rounded-[14px] overflow-hidden'
const CARD_HEAD = 'px-4 py-3 border-b border-line flex justify-between items-baseline gap-3'
const MONO_SMALL = 'font-mono text-[10.5px] text-ink-3'

const Panel = ({ children }: { children: React.ReactNode }) => (
  <div className="bg-paper border border-line rounded-[14px] p-4 text-[14px] text-ink-3">{children}</div>
)

export default function InboxTagsPage() {
  const { role, loading: userLoading } = useUser()
  const toast = useToast()
  const isManager = !!role && atLeast(role as Role, 'MANAGER')

  const [tags, setTags] = useState<ManagedTag[] | null>(null)
  const [routes, setRoutes] = useState<Routes | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // The sheet: undefined = closed, null = a new tag, a tag = that tag.
  const [editing, setEditing] = useState<ManagedTag | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [savingReason, setSavingReason] = useState<Reason | null>(null)

  const load = useCallback(async () => {
    const [t, r] = await Promise.all([
      call<{ tags: ManagedTag[] }>('/api/inbox/tags'),
      call<{ routes: Routes }>('/api/inbox/flag-routes'),
    ])
    if (!t.ok) { setLoadError(t.error); return }
    if (!r.ok) { setLoadError(r.error); return }
    setLoadError(null)
    setTags(t.data.tags)
    setRoutes(r.data.routes)
  }, [])

  useEffect(() => {
    if (isManager) load()
  }, [isManager, load])

  const active = (tags ?? []).filter(t => t.isActive)
  const mine = active.filter(t => !t.builtIn)
  const builtIn = active.filter(t => t.builtIn)

  const save = async (draft: TagDraft) => {
    if (busy || editing === undefined) return
    setBusy(true)
    const tag = editing
    const r = tag
      ? await call<{ tag: ManagedTag }>(`/api/inbox/tags/${tag.id}`, {
          method: 'PATCH',
          body: JSON.stringify(tag.builtIn
            ? { name: draft.name, color: draft.color }
            : { name: draft.name, color: draft.color, cookCanPick: draft.cookCanPick }),
        })
      : await call<{ tag: ManagedTag }>('/api/inbox/tags', { method: 'POST', body: JSON.stringify(draft) })
    if (!r.ok) {
      toast.show({ type: 'error', title: r.error })
      setBusy(false)
      return
    }
    setEditing(undefined)
    await load()
    setBusy(false)
  }

  const remove = async () => {
    if (busy || !editing) return
    setBusy(true)
    const r = await call<{ ok: true }>(`/api/inbox/tags/${editing.id}`, { method: 'DELETE' })
    if (!r.ok) {
      toast.show({ type: 'error', title: r.error })
      setBusy(false)
      return
    }
    setEditing(undefined)
    await load()
    setBusy(false)
  }

  const reroute = async (reason: Reason, tagId: string) => {
    if (savingReason || routes?.[reason] === tagId) return
    setSavingReason(reason)
    const r = await call<{ ok: true }>('/api/inbox/flag-routes', {
      method: 'PUT',
      body: JSON.stringify({ reason, tagId }),
    })
    if (!r.ok) toast.show({ type: 'error', title: r.error })
    else setRoutes(prev => (prev ? { ...prev, [reason]: tagId } : prev))
    setSavingReason(null)
  }

  const body = userLoading ? <Panel>Loading…</Panel>
    : !isManager ? <Panel>Inbox tags are for managers.</Panel>
    : loadError && !tags ? (
      <div className="bg-paper border border-line rounded-[14px] p-4 flex flex-col gap-3">
        <p className="m-0 text-[14px] text-red-text">{loadError}</p>
        <button type="button" onClick={load} className="self-start min-h-[44px] px-4 rounded-[10px] border border-line-2 text-[13px] font-medium text-ink-2">Try again</button>
      </div>
    )
    : !tags || !routes ? <Panel>Loading…</Panel>
    : (
      <>
        <section className={CARD} aria-label="Your tags">
          <div className={CARD_HEAD}>
            <span className="text-[13.5px] font-semibold">Your tags</span>
            <span className={MONO_SMALL}>COOKS CAN PICK THESE</span>
          </div>
          {mine.map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => setEditing(t)}
              className="w-full flex items-center gap-3 px-4 min-h-[56px] border-t border-bg-2 first-of-type:border-t-0 text-left"
            >
              <TagDot color={t.color} size={10} />
              <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                <span className="text-[15px] font-medium break-words">{t.name}</span>
                <span className={MONO_SMALL}>
                  {t.openCount ?? 0} OPEN{t.cookCanPick ? '' : ' · COOKS CAN’T PICK'}
                </span>
              </span>
              <span className="text-ink-4" aria-hidden>›</span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => setEditing(null)}
            className={`w-full min-h-[48px] px-4 text-left text-[13.5px] font-medium text-gold-2 ${mine.length ? 'border-t border-line' : ''}`}
          >
            + Add a tag
          </button>
        </section>

        <section className={CARD} aria-label="Built in">
          <div className={CARD_HEAD}>
            <span className="text-[13.5px] font-semibold">Built in</span>
            <span className={`${MONO_SMALL} text-right`}>THE APP FILES ITS OWN ALERTS HERE</span>
          </div>
          {builtIn.map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => setEditing(t)}
              className="w-full flex items-center gap-3 px-4 min-h-[52px] border-t border-bg-2 first-of-type:border-t-0 text-left"
            >
              <TagDot color={t.color} size={10} />
              <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                <span className="text-[15px] font-medium break-words">{t.name}</span>
                <span className={MONO_SMALL}>{BUILT_IN_META[t.builtIn ?? ''] ?? ''}</span>
              </span>
              <span className="flex-none font-mono text-[10px] px-2 py-[3px] rounded-full bg-bg-2 text-ink-2">RENAME</span>
            </button>
          ))}
        </section>

        <section className={CARD} aria-label="Where cooks’ flags land">
          <div className={CARD_HEAD}>
            <span className="text-[13.5px] font-semibold">Where cooks’ flags land</span>
          </div>
          {REASONS.map(({ reason, label }) => {
            const current = routes[reason]
            const known = active.some(t => t.id === current)
            return (
              <label key={reason} className="flex items-center gap-3 px-4 min-h-[56px] border-t border-bg-2 first-of-type:border-t-0">
                <span className="flex-1 text-[14px]">Flagged “{label}”</span>
                <select
                  aria-label={`Where “${label}” flags land`}
                  value={known ? current ?? '' : ''}
                  disabled={savingReason !== null}
                  onChange={e => reroute(reason, e.target.value)}
                  className="h-11 max-w-[55%] border border-line-2 rounded-[9px] px-2.5 text-[13.5px] bg-paper disabled:opacity-60"
                >
                  {!known && <option value="" disabled>Pick a tag</option>}
                  {active.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
            )
          })}
          <div className="flex items-center gap-3 px-4 min-h-[52px] border-t border-bg-2">
            <span className="flex-1 text-[14px]">Out of range</span>
            <span className="text-[13.5px] text-ink-3">→ Food safety (always)</span>
          </div>
        </section>
      </>
    )

  return (
    <>
      <div className="max-w-[640px] mx-auto w-full flex flex-col gap-3.5">
        <SectionTabs tabs={inboxTabs(role as Role | null)} active="tags" label="Inbox pages" />
        <h1 className="m-0 text-[26px] leading-[1.1] font-semibold tracking-[-0.035em]">Inbox tags</h1>
        <p className="m-0 text-[14px] leading-[1.45] text-ink-2">
          Tags sort the Inbox. Cooks pick one when they report something. Changes show up for everyone straight away.
        </p>
        {body}
      </div>
      {editing !== undefined && (
        <TagSheet
          key={editing?.id ?? 'new'}
          tag={editing}
          busy={busy}
          onSave={save}
          onRemove={remove}
          onClose={() => { if (!busy) setEditing(undefined) }}
        />
      )}
    </>
  )
}
