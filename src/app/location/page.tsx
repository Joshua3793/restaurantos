'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useRc } from '@/contexts/RevenueCenterContext'
import { LocationDashboard } from '@/components/locations/LocationDashboard'

/**
 * Read-only landing surface for a selected LOCATION.
 *
 * A location aggregates its child revenue centers and holds no stock of its own,
 * so the operational pages (count/sales/prep…) don't apply. The two-tier
 * selector navigates here when a Location is picked. If the active node is an RC
 * or "all" (e.g. user navigated here directly, then switched), bounce to /pass.
 */
export default function LocationPage() {
  const router = useRouter()
  const { activeKind, activeLocationId } = useRc()

  useEffect(() => {
    if (activeKind !== 'location') router.replace('/pass')
  }, [activeKind, router])

  if (activeKind !== 'location' || !activeLocationId) return null

  return <LocationDashboard locationId={activeLocationId} />
}
