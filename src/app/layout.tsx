import type { Metadata } from 'next'
import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'
import './globals.css'
import { Navigation } from '@/components/Navigation'
import { MobileRcBar } from '@/components/navigation/MobileRcBar'
import { GlobalSearch } from '@/components/GlobalSearch'
import { CostChromeGate } from '@/components/layout/CostChromeGate'
import { RcProvider } from '@/contexts/RevenueCenterContext'
import { AiChat } from '@/components/AiChat'
import { UserProvider } from '@/contexts/UserContext'
import { DrawerProvider } from '@/contexts/DrawerContext'
import { NotificationProvider } from '@/contexts/NotificationContext'
import { ToastProvider } from '@/components/Toast'


export const metadata: Metadata = {
  title: 'CONTROLA OS',
  description: 'Restaurant Management System for Fergie\'s Kitchen',
  appleWebApp: {
    title: 'Controla OS',
    statusBarStyle: 'black-translucent',
    capable: true,
  },
  icons: {
    apple: '/apple-touch-icon.png',
  },
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
      <body className={`${GeistSans.variable} ${GeistMono.variable}`}>
        <UserProvider>
        <RcProvider>
        <ToastProvider>
        <NotificationProvider>
        <DrawerProvider>
          <Navigation />
          <MobileRcBar />
          <GlobalSearch />
          <main className="md:ml-[240px] pb-20 md:pb-0 mobile-content-top md:pt-0 min-h-screen bg-[#fafaf9] flex flex-col">
            <CostChromeGate />
            <div className="flex-1 p-4 md:p-6 md:px-8 max-w-7xl mx-auto w-full">
              {children}
            </div>
          </main>
          <AiChat />
        </DrawerProvider>
        </NotificationProvider>
        </ToastProvider>
        </RcProvider>
        </UserProvider>
      </body>
    </html>
  )
}
