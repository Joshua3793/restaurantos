'use client'
import dynamic from 'next/dynamic'
import { DollarSign } from 'lucide-react'
import { PageHead } from '@/components/layout/PageHead'
import { ReportsSubnav } from '../ReportsSubnav'
import { LoadingState } from '../report-components'

const CogsTab = dynamic(() => import('../tabs/CogsTab'), { ssr: false, loading: () => <LoadingState /> })

export default function ReportsCogsPage() {
  return (
    <div>
      <PageHead
        crumbs={<><DollarSign size={12} /> INSIGHTS / REPORTS / COGS</>}
        title="Cost of goods sold"
        sub={<>Beginning inventory + purchases − ending inventory, for any date range.</>}
      />
      <ReportsSubnav />
      <CogsTab />
    </div>
  )
}
