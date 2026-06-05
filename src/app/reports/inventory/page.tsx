'use client'
import dynamic from 'next/dynamic'
import { useState } from 'react'
import { Package } from 'lucide-react'
import { PageHead } from '@/components/layout/PageHead'
import { ReportsSubnav, PeriodSelector } from '../ReportsSubnav'
import { LoadingState } from '../report-components'

const InventoryTab = dynamic(() => import('../tabs/InventoryTab'), { ssr: false, loading: () => <LoadingState /> })

export default function ReportsInventoryPage() {
  const [period, setPeriod] = useState(30)
  return (
    <div>
      <PageHead
        crumbs={<><Package size={12} /> INSIGHTS / REPORTS / INVENTORY</>}
        title="Inventory analytics"
        sub={<>Value trends, price movements, and supplier volatility.</>}
      />
      <ReportsSubnav />
      <PeriodSelector period={period} setPeriod={setPeriod} />
      <InventoryTab period={period} />
    </div>
  )
}
