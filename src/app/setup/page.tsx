'use client'
import Link from 'next/link'
import {
  Truck, Building2, MapPin, Tag, Ruler, Users, Bell,
} from 'lucide-react'
import { PageHead } from '@/components/layout/PageHead'

interface Card {
  href: string
  label: string
  icon: React.ComponentType<{ size?: number | string }>
  description: string
  built: boolean
}

const cards: Card[] = [
  { href: '/setup/suppliers',       label: 'Suppliers',        icon: Truck,    description: 'Vendor directory, price history, contact info.',                  built: true },
  { href: '/setup/revenue-centers', label: 'Revenue centers',  icon: Building2,description: 'Profit centers, allocations, food-cost targets.',                 built: true },
  { href: '/setup/storage-areas',   label: 'Storage areas',    icon: MapPin,   description: 'Walk-ins, dry storage, bar. Drives count routing.',               built: true },
  { href: '/setup/categories',      label: 'Categories',       icon: Tag,      description: 'Inventory and recipe categories, accent colors.',                 built: true },
  { href: '/setup/users',           label: 'Users & roles',    icon: Users,    description: 'Invite teammates; ADMIN / MANAGER / STAFF.',                      built: true },
  { href: '/setup/uom',             label: 'UOM & conversions',icon: Ruler,    description: 'Unit-of-measure groups, custom conversions, inspector.',          built: false },
  { href: '/setup/general',         label: 'General',          icon: Bell,     description: 'Email digest schedule, notifications, brand.',                    built: false },
]

export default function SetupPage() {
  return (
    <div>
      <PageHead
        crumbs={<><span>SETUP</span></>}
        title="Setup"
        sub={<>Configure suppliers, storage, categories, and team access — demoted from the daily nav.</>}
      />

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {cards.map(card => (
          <SetupCard key={card.href} {...card} />
        ))}
      </div>
    </div>
  )
}

function SetupCard({ href, label, icon: Icon, description, built }: Card) {
  const inner = (
    <div className="h-full bg-paper border border-line rounded-[12px] p-5 hover:border-ink-3 transition-colors">
      <div className="flex items-center justify-between mb-3">
        <div className="w-9 h-9 rounded-[9px] bg-bg-2 flex items-center justify-center text-ink-2">
          <Icon size={16} />
        </div>
        {!built && (
          <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.04em] bg-bg-2 text-ink-3 px-2 py-0.5 rounded-full">
            Soon
          </span>
        )}
      </div>
      <h3 className="text-[15px] font-semibold tracking-[-0.015em] text-ink mb-1">{label}</h3>
      <p className="text-[12.5px] text-ink-3 leading-snug">{description}</p>
    </div>
  )
  return built
    ? <Link href={href} className="block">{inner}</Link>
    : <div className="block opacity-60 cursor-not-allowed">{inner}</div>
}
