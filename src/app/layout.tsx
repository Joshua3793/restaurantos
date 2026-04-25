import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { Navigation } from '@/components/Navigation'
import { MobileRcBar } from '@/components/navigation/MobileRcBar'
import { GlobalSearch } from '@/components/GlobalSearch'
import { RcProvider } from '@/contexts/RevenueCenterContext'
import { AiChat } from '@/components/AiChat'
import { UserProvider } from '@/contexts/UserContext'
import { DrawerProvider } from '@/contexts/DrawerContext'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'CONTROLA OS',
  description: 'Restaurant Management System for Fergie\'s Kitchen',
}

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover' as const,
  interactiveWidget: 'resizes-content',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <UserProvider>
        <RcProvider>
        <DrawerProvider>
          <Navigation />
          <MobileRcBar />
          <GlobalSearch />
          <main className="md:ml-56 pb-20 md:pb-0 pt-10 md:pt-0 min-h-screen bg-gray-50">
            <div className="p-4 md:p-6 max-w-7xl mx-auto">
              {children}
            </div>
          </main>
          <AiChat />
        </DrawerProvider>
        </RcProvider>
        </UserProvider>
      </body>
    </html>
  )
}
