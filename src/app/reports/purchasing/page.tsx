'use client'
import dynamic from 'next/dynamic'
import { ShoppingCart } from 'lucide-react'
import { PageHead } from '@/components/layout/PageHead'
import { ReportsSubnav } from '../ReportsSubnav'
import { LoadingState } from '../report-components'

const PurchasingTab = dynamic(() => import('../tabs/PurchasingTab'), { ssr: false, loading: () => <LoadingState /> })

export default function ReportsPurchasingPage() {
  return (
    <div>
      <PageHead
        crumbs={<><ShoppingCart size={12} /> INSIGHTS / REPORTS / PURCHASING</>}
        title="Purchasing"
        sub={<>Approved-invoice spend by supplier and item.</>}
      />
      <ReportsSubnav />
      <PurchasingTab />
    </div>
  )
}
