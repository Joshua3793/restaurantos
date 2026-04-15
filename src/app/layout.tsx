import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { Navigation } from '@/components/Navigation'
import { GlobalSearch } from '@/components/GlobalSearch'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'CONTROLA OS',
  description: 'Restaurant Management System for Fergie\'s Kitchen',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <Navigation />
        <GlobalSearch />
        <main className="md:ml-56 pb-20 md:pb-0 min-h-screen bg-gray-50">
          <div className="p-4 md:p-6 max-w-7xl mx-auto">
            {children}
          </div>
        </main>
      </body>
    </html>
  )
}
