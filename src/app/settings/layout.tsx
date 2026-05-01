'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Settings, Layers, ChevronRight, Users } from 'lucide-react'

const sections = [
  {
    group: 'General',
    items: [
      { href: '/settings', label: 'General', icon: Settings, description: 'Email digest and notifications' },
    ],
  },
  {
    group: 'Management',
    items: [
      { href: '/settings/revenue-centers', label: 'Revenue Centers', icon: Layers, description: 'Manage profit centers and allocations' },
    ],
  },
  {
    group: 'Team',
    items: [
      { href: '/settings/users', label: 'Users', icon: Users, description: 'Invite and manage team members' },
    ],
  },
]

function SidebarNav() {
  const pathname = usePathname()

  return (
    <aside className="hidden md:block w-56 shrink-0">
      <h1 className="text-xl font-bold text-gray-900 mb-6 px-3">Settings</h1>
      <nav className="space-y-4">
        {sections.map(({ group, items }) => (
          <div key={group}>
            <p className="px-3 mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">{group}</p>
            <div className="space-y-0.5">
              {items.map(({ href, label, icon: Icon }) => {
                const active = pathname === href
                return (
                  <Link
                    key={href}
                    href={href}
                    className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                      active
                        ? 'bg-gold/10 text-gold'
                        : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                    }`}
                  >
                    <Icon size={16} className={active ? 'text-gold' : 'text-gray-400'} />
                    {label}
                  </Link>
                )
              })}
            </div>
          </div>
        ))}
      </nav>
    </aside>
  )
}

function MobileSettingsIndex() {
  return (
    <div className="md:hidden">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Settings</h1>
      <div className="space-y-5">
        {sections.map(({ group, items }) => (
          <div key={group}>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-2 px-1">{group}</p>
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm divide-y divide-gray-50">
              {items.map(({ href, label, icon: Icon, description }) => (
                <Link
                  key={href}
                  href={href}
                  className="flex items-center gap-3 px-4 py-3.5 hover:bg-gray-50 transition-colors first:rounded-t-xl last:rounded-b-xl"
                >
                  <div className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
                    <Icon size={16} className="text-gray-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900">{label}</p>
                    <p className="text-xs text-gray-400 truncate">{description}</p>
                  </div>
                  <ChevronRight size={16} className="text-gray-300 shrink-0" />
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const isRoot = pathname === '/settings'

  return (
    <div className="max-w-5xl mx-auto">
      <div className="hidden md:flex gap-10">
        <SidebarNav />
        <div className="flex-1 min-w-0 pt-1">{children}</div>
      </div>
      <div className="md:hidden">
        {isRoot ? (
          <MobileSettingsIndex />
        ) : (
          <div>
            <Link href="/settings" className="inline-flex items-center gap-1 text-sm text-gold mb-4">
              <ChevronRight size={14} className="rotate-180" />
              Settings
            </Link>
            {children}
          </div>
        )}
      </div>
    </div>
  )
}
