'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { StartDesktop } from '@/components/start/StartDesktop'

// The manager's desktop start page. What it shows (and why the old KPI wall
// moved to Reports) is described in src/lib/start-page.ts.
//
// Phones (below md, 768px) go to /today instead: it shows a manager the same
// alerts in a layout made for a phone, where this dashboard is cramped. The
// dashboard is CSS-hidden below md so it never flashes before the hop. The
// width is watched, not read once: an iPad Split View narrowed below md would
// otherwise leave a blank page.
export default function PassPage() {
  const router = useRouter()
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    if (mq.matches) { router.replace('/today'); return }
    const onChange = (e: MediaQueryListEvent) => { if (e.matches) router.replace('/today') }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [router])
  return (
    <div className="hidden md:block">
      <StartDesktop />
    </div>
  )
}
