'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useUser } from '@/contexts/UserContext'
import { Camera, ClipboardList, Flame, Bell, ChevronRight, Thermometer } from 'lucide-react'
import { MPageHead, MCard, MSectionLabel, MQuickAction, MProgressBar } from '@/components/mobile/kit'

interface Kpis { awaitingApprovalCount: number; priceAlertCount: number }
interface PrepItem { id: string; name: string; onHand?: number; parLevel?: number; isOnList?: boolean }

export function TodayManager() {
  const router = useRouter()
  const { user } = useUser()
  const [kpis, setKpis] = useState<Kpis | null>(null)
  const [prep, setPrep] = useState<PrepItem[]>([])

  useEffect(() => {
    fetch('/api/invoices/kpis').then(r => r.ok ? r.json() : null).then(d => d && setKpis(d)).catch(() => {})
    fetch('/api/prep/items').then(r => r.ok ? r.json() : null).then((d: PrepItem[] | null) => {
      if (!Array.isArray(d)) return
      const onList = d.filter(x => x.isOnList)
      setPrep((onList.length ? onList : d).slice(0, 3))
    }).catch(() => {})
  }, [])

  const firstName = (user?.name || user?.email?.split('@')[0] || 'there').split(' ')[0]
  const needs = [
    kpis && kpis.priceAlertCount > 0 && { icon: Bell, title: `${kpis.priceAlertCount} price alert${kpis.priceAlertCount > 1 ? 's' : ''}`, body: 'Cost impact to review', href: '/signals', accent: '#dc2626' },
    kpis && kpis.awaitingApprovalCount > 0 && { icon: Camera, title: `${kpis.awaitingApprovalCount} invoice${kpis.awaitingApprovalCount > 1 ? 's' : ''} to review`, body: 'OCR matched — confirm & approve', href: '/invoices', accent: '#d97706' },
  ].filter(Boolean) as { icon: typeof Bell; title: string; body: string; href: string; accent: string }[]

  return (
    <>
      <MPageHead eyebrow={greetingEyebrow()} title={`Good ${dayPart()}, ${firstName}.`} />

      {/* The dark cost-chrome strip is mounted globally by CostChromeGate on /today. */}

      <MSectionLabel right={needs.length ? `${needs.length} item${needs.length > 1 ? 's' : ''}` : undefined}>Needs you</MSectionLabel>
      {needs.length === 0 ? (
        <MCard><div className="font-mono text-[11px] text-ink-3">Nothing needs you right now.</div></MCard>
      ) : (
        <div className="flex flex-col gap-2">
          {needs.map((n, i) => {
            const Ico = n.icon
            return (
              <MCard key={i} accent={n.accent} onClick={() => router.push(n.href)}>
                <div className="flex items-center gap-3">
                  <span className="grid place-items-center w-9 h-9 rounded-[10px] bg-ink text-gold shrink-0"><Ico size={18} /></span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-[14.5px] font-semibold tracking-[-0.01em]">{n.title}</span>
                    <span className="block font-mono text-[11px] text-ink-3 mt-0.5">{n.body}</span>
                  </span>
                  <ChevronRight size={17} className="text-ink-4" />
                </div>
              </MCard>
            )
          })}
        </div>
      )}

      <MSectionLabel right={<button onClick={() => router.push('/prep')}>open →</button>}>Today · prep</MSectionLabel>
      <MCard onClick={() => router.push('/prep')}>
        {prep.length === 0 ? (
          <div className="font-mono text-[11px] text-ink-3">No prep planned.</div>
        ) : (
          <div className="flex flex-col gap-3">
            {prep.map(p => {
              const par = Number(p.parLevel ?? 0)
              const pct = par > 0 ? Math.round((Number(p.onHand ?? 0) / par) * 100) : 0
              return (
                <div key={p.id}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[13.5px] font-medium truncate">{p.name}</span>
                    <span className="font-mono text-[11px] text-ink-3">{pct}%</span>
                  </div>
                  <MProgressBar pct={pct} tone={pct < 50 ? 'bad' : pct < 100 ? 'warn' : 'ok'} />
                </div>
              )
            })}
          </div>
        )}
      </MCard>

      <MSectionLabel>Quick actions</MSectionLabel>
      <div className="grid grid-cols-2 gap-2">
        <MQuickAction label="Capture invoice" icon={<Camera size={20} />} onClick={() => router.push('/invoices')} />
        <MQuickAction label="Schedule count" icon={<ClipboardList size={20} />} onClick={() => router.push('/count')} />
        <MQuickAction label="Log waste" icon={<Flame size={20} />} onClick={() => router.push('/wastage')} />
        <MQuickAction label="Temps" icon={<Thermometer size={20} />} onClick={() => router.push('/temps')} />
      </div>
    </>
  )
}

function dayPart() {
  const h = new Date().getHours()
  return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'
}
function greetingEyebrow() {
  return new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase()
}
