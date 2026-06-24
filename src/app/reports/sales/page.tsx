'use client'
import dynamic from 'next/dynamic'
import { TrendingUp } from 'lucide-react'
import { PageHead } from '@/components/layout/PageHead'
import { ReportsSubnav } from '../ReportsSubnav'
import { LoadingState } from '../report-components'

const SalesTab = dynamic(() => import('../tabs/SalesTab'), { ssr: false, loading: () => <LoadingState /> })

export default function ReportsSalesPage() {
  return (
    <div>
      <PageHead
        crumbs={<><TrendingUp size={12} /> INSIGHTS / REPORTS / SALES</>}
        title="Sales analytics"
        sub={<>Revenue, top menu items, and weekly trends over any period.</>}
      />
      <ReportsSubnav />
      <SalesTab />
    </div>
  )
}
