'use client'
import dynamic from 'next/dynamic'
import { ChefHat } from 'lucide-react'
import { PageHead } from '@/components/layout/PageHead'
import { ReportsSubnav } from '../ReportsSubnav'
import { LoadingState } from '../report-components'

const PrepTab = dynamic(() => import('../tabs/PrepTab'), { ssr: false, loading: () => <LoadingState /> })

export default function ReportsPrepPage() {
  return (
    <div>
      <PageHead
        crumbs={<><ChefHat size={12} /> INSIGHTS / REPORTS / PREP</>}
        title="Prep performance"
        sub={<>Completion rates, most-prepped items, and blockers over time.</>}
      />
      <ReportsSubnav />
      <PrepTab />
    </div>
  )
}
