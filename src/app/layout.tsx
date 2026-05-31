import type { Metadata } from 'next'
import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'
import { Fraunces } from 'next/font/google'
import './globals.css'

// Fraunces — the brand display serif, used for invoice/section titles in the
// invoice review drawer (Implementation.html §5: "Title: Fraunces 500").
const fraunces = Fraunces({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-fraunces',
  display: 'swap',
})
import { Navigation } from '@/components/Navigation'
import { MobileRcBar } from '@/components/navigation/MobileRcBar'
import { GlobalSearch } from '@/components/GlobalSearch'
import { KeyboardShortcuts } from '@/components/layout/KeyboardShortcuts'
import { SidebarProvider } from '@/contexts/SidebarContext'
import { AppShell } from '@/components/layout/AppShell'
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
      <body className={`${GeistSans.variable} ${GeistMono.variable} ${fraunces.variable}`}>
        <UserProvider>
        <RcProvider>
        <ToastProvider>
        <NotificationProvider>
        <DrawerProvider>
        <SidebarProvider>
          <Navigation />
          <MobileRcBar />
          <GlobalSearch />
          <KeyboardShortcuts />
          <AppShell>{children}</AppShell>
          <AiChat />
        </SidebarProvider>
        </DrawerProvider>
        </NotificationProvider>
        </ToastProvider>
        </RcProvider>
        </UserProvider>
      </body>
    </html>
  )
}
