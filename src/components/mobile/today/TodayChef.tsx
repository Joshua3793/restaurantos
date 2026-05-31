'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useUser } from '@/contexts/UserContext'
import { ClipboardList, Barcode, Flame, ChefHat, ArrowRight } from 'lucide-react'
import { MPageHead, MCard, MSectionLabel, MQuickAction, MProgressBar } from '@/components/mobile/kit'

// Shape from GET /api/count/sessions: each session row + { counts: { total, counted, skipped } }
interface CountSession { id: string; status: string; label: string; counts?: { total: number; counted: number; skipped: number } }
interface PrepItem { id: string; name: string; station?: string | null; isOnList?: boolean }

export function TodayChef() {
  const router = useRouter()
  const { user } = useUser()
  const [session, setSession] = useState<CountSession | null>(null)
  const [prep, setPrep] = useState<PrepItem[]>([])

  useEffect(() => {
    fetch('/api/count/sessions').then(r => r.ok ? r.json() : null)
      .then((d: CountSession[] | null) => { if (Array.isArray(d)) setSession(d.find(s => s.status === 'IN_PROGRESS') ?? null) })
      .catch(() => {})
    fetch('/api/prep/items').then(r => r.ok ? r.json() : null).then((d: PrepItem[] | null) => {
      if (!Array.isArray(d)) return
      const onList = d.filter(x => x.isOnList)
      setPrep((onList.length ? onList : d).slice(0, 3))
    }).catch(() => {})
  }, [])

  const firstName = (user?.name || user?.email?.split('@')[0] || 'chef').split(' ')[0]
  const counted = Number(session?.counts?.counted ?? 0)
  const total = Number(session?.counts?.total ?? 0)
  const pct = total > 0 ? Math.round((counted / total) * 100) : 0

  return (
    <>
      <MPageHead eyebrow={greetingEyebrow()} title={`Good ${dayPart()}, ${firstName}.`} />

      {session && (
        <MCard className="bg-ink text-paper border-ink" onClick={() => router.push('/count')}>
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] text-ink-4 uppercase tracking-[0.06em]">Resume count</span>
            <span className="grid place-items-center w-7 h-7 rounded-full bg-ink-2"><ArrowRight size={15} color="#d97706" /></span>
          </div>
          <div className="text-[16px] font-semibold mt-2 mb-1">{session.label}</div>
          <div className="font-mono text-[11px] text-ink-4 mb-2.5">{counted} of {total} counted</div>
          <MProgressBar pct={pct} tone="warn" />
        </MCard>
      )}

      <MSectionLabel right={<button onClick={() => router.push('/prep')}>open →</button>}>Your prep</MSectionLabel>
      <div className="flex flex-col gap-2">
        {prep.length === 0 ? (
          <MCard><div className="font-mono text-[11px] text-ink-3">No prep assigned.</div></MCard>
        ) : prep.map(p => (
          <MCard key={p.id} onClick={() => router.push('/prep')}>
            <div className="flex items-center gap-3">
              <span className="grid place-items-center w-9 h-9 rounded-[10px] bg-bg-2 text-ink-2 shrink-0"><ChefHat size={18} /></span>
              <span className="flex-1 min-w-0">
                <span className="block text-[14.5px] font-semibold tracking-[-0.01em] truncate">{p.name}</span>
                <span className="block font-mono text-[11px] text-ink-3 mt-0.5">{p.station ?? 'Prep'}</span>
              </span>
            </div>
          </MCard>
        ))}
      </div>

      <MSectionLabel>Quick actions</MSectionLabel>
      <div className="grid grid-cols-2 gap-2">
        <MQuickAction label="Start a count" icon={<ClipboardList size={20} />} onClick={() => router.push('/count')} />
        <MQuickAction label="Scan an item" icon={<Barcode size={20} />} onClick={() => router.push('/inventory')} />
        <MQuickAction label="Log waste" icon={<Flame size={20} />} onClick={() => router.push('/wastage')} />
        <MQuickAction label="My prep list" icon={<ChefHat size={20} />} onClick={() => router.push('/prep')} />
      </div>
    </>
  )
}

function dayPart() { const h = new Date().getHours(); return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening' }
function greetingEyebrow() { return new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase() }
