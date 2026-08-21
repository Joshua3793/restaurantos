'use client'
import { useEffect, useState } from 'react'
import { Banknote } from 'lucide-react'
import { PageHead } from '@/components/layout/PageHead'
import { MyPayoutDetail } from '@/components/tips/MyPayoutDetail'
import { money, hoursLabel } from '@/components/tips/kit'
import type { MyPayout } from '@/lib/tips/me'

type Data =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'unlinked' }
  | { state: 'ready'; name: string; payouts: MyPayout[] }

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="border border-line rounded-xl bg-paper px-6 py-12 text-center">
      <p className="text-[15px] font-medium text-ink mb-1.5">{title}</p>
      <p className="text-[13px] text-ink-3 max-w-sm mx-auto leading-relaxed">{body}</p>
    </div>
  )
}

export default function MyTipsPage() {
  const [data, setData] = useState<Data>({ state: 'loading' })
  const [tab, setTab] = useState<'latest' | 'history'>('latest')
  const [selected, setSelected] = useState(0)

  useEffect(() => {
    let live = true
    fetch('/api/tips/me')
      .then(async res => {
        if (!res.ok) throw new Error(`Couldn’t load your payouts (${res.status})`)
        return res.json()
      })
      .then(body => {
        if (!live) return
        if (!body.linked) return setData({ state: 'unlinked' })
        setData({ state: 'ready', name: body.name, payouts: body.payouts ?? [] })
      })
      .catch(e => live && setData({ state: 'error', message: e.message }))
    return () => { live = false }
  }, [])

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 md:py-8">
      <PageHead
        crumbs={<><Banknote size={12} /> TEAM / TIP PAYOUTS</>}
        title="Your tips"
        sub="What you were paid, and the hours it came from."
      />

      {data.state === 'loading' && (
        <div className="border border-line rounded-xl bg-paper h-64 animate-pulse" />
      )}

      {data.state === 'error' && (
        <div className="border border-line rounded-xl bg-paper px-6 py-10 text-center">
          <p className="text-[13.5px] text-ink-2 mb-3">{data.message}</p>
          <button
            onClick={() => { setData({ state: 'loading' }); location.reload() }}
            className="px-3.5 py-2 rounded border border-line bg-paper text-[13px] font-medium text-ink-2 hover:border-ink-3"
          >
            Try again
          </button>
        </div>
      )}

      {/* Never $0.00 — no account link and no money are different facts. */}
      {data.state === 'unlinked' && (
        <Empty
          title="Your payouts aren’t linked to your account yet"
          body="Ask a manager to link your login on the tips roster. Once they do, every payout shows up here."
        />
      )}

      {data.state === 'ready' && data.payouts.length === 0 && (
        <Empty
          title="No payouts yet"
          body="Your first one shows up here once it’s been paid out."
        />
      )}

      {data.state === 'ready' && data.payouts.length > 0 && (
        <>
          <div className="flex border-b border-line mb-5">
            {(['latest', 'history'] as const).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 py-2.5 text-[13px] capitalize ${
                  tab === t ? 'text-ink font-semibold border-b-2 border-gold' : 'text-ink-3'
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {tab === 'latest' && <MyPayoutDetail payout={data.payouts[selected]} />}

          {tab === 'history' && (
            <div>
              {data.payouts.map((p, i) => (
                <button
                  key={p.periodId}
                  onClick={() => { setSelected(i); setTab('latest') }}
                  className="w-full flex items-center gap-3 border border-line rounded-lg px-3 py-2.5 mb-2 text-left hover:border-ink-3"
                >
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-ink">{p.startDate} – {p.endDate}</span>
                    <span className="block font-mono text-[10.5px] text-ink-3">
                      {hoursLabel(p.hoursTotal)} · {money(p.perHour)}/h
                      {p.status === 'BEING_CORRECTED' ? ' · being corrected' : ''}
                    </span>
                  </span>
                  {/* Same figure the Latest headline shows, so the tabs never disagree. */}
                  <span className="ml-auto text-[17px] font-semibold text-ink shrink-0">
                    {money(p.envelopeCents / 100)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
