'use client'
import dynamic from 'next/dynamic'
import { useState } from 'react'
import { ShoppingCart } from 'lucide-react'
import { PageHead } from '@/components/layout/PageHead'
import { ReportsSubnav, PeriodSelector } from '../ReportsSubnav'
import { LoadingState } from '../report-components'

const PurchasingTab = dynamic(() => import('../tabs/PurchasingTab'), { ssr: false, loading: () => <LoadingState /> })

export default function ReportsPurchasingPage() {
  const [period, setPeriod] = useState(30)
  return (
    <div>
      <PageHead
        crumbs={<><ShoppingCart size={12} /> INSIGHTS / REPORTS / PURCHASING</>}
        title="Purchasing"
        sub={<>Approved-invoice spend by supplier and item.</>}
      />
      <ReportsSubnav />
      <PeriodSelector period={period} setPeriod={setPeriod} />
      <PurchasingTab period={period} />
    </div>
  )
}
