# Fergie's OS — Design Foundations (tokens, UI primitives, app shell)

Tailwind config, global CSS, design-system primitives, layout chrome, contexts, cross-cutting components. Start here.


---

## `tailwind.config.ts`

```ts
import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/lib/**/*.{js,ts}",
  ],
  theme: {
    extend: {
      colors: {
        // ── Design system tokens (Implementation.html) ─────────────────────
        // Surfaces
        bg:          '#fafaf9',
        'bg-2':      '#f4f4f5',
        paper:       '#ffffff',
        // Ink scale
        ink:         '#09090b',
        'ink-2':     '#27272a',
        'ink-3':     '#71717a',
        'ink-4':     '#a1a1aa',
        // Borders
        line:        '#e4e4e7',
        'line-2':    '#d4d4d8',
        // Brand accent — amber (use sparingly)
        gold:        '#d97706',
        'gold-2':    '#b45309',   // text-safe on light bg
        'gold-soft': '#fef3c7',
        // Semantic data colors (consistent with Tailwind defaults for fallback)
        red:           '#dc2626',  // red-600
        'red-soft':    '#fee2e2',  // red-100
        'red-text':    '#b91c1c',  // red-700
        green:         '#16a34a',  // green-600
        'green-soft':  '#dcfce7',  // green-100
        'green-text':  '#15803d',  // green-700
        blue:          '#2563eb',  // blue-600
        'blue-soft':   '#dbeafe',  // blue-100
        'blue-text':   '#1d4ed8',  // blue-700
        // ── Legacy (keep during migration) ─────────────────────────────────
        background: "var(--background)",
        foreground: "var(--foreground)",
      },
      fontFamily: {
        sans: ['var(--font-geist-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-geist-mono)', 'ui-monospace', 'monospace'],
        fraunces: ['var(--font-fraunces)', 'Fraunces', 'ui-serif', 'Georgia', 'serif'],
      },
      borderRadius: {
        sm:  '6px',
        DEFAULT: '8px',
        md:  '10px',
        lg:  '12px',
        xl:  '16px',
        '2xl': '20px',
        '3xl': '24px',
        full: '9999px',
      },
      fontSize: {
        label:   ['10.5px', { letterSpacing: '0.08em',  lineHeight: '1.2' }],
        caption: ['11.5px', { lineHeight: '1.45' }],
        body:    ['13.5px', { lineHeight: '1.55' }],
        h2:      ['17px',   { lineHeight: '1.3',  fontWeight: '600' }],
        h1:      ['28px',   { lineHeight: '1.1',  letterSpacing: '-0.01em', fontWeight: '600' }],
        display: ['56px',   { lineHeight: '1',    letterSpacing: '-0.02em' }],
      },
    },
  },
  plugins: [],
};

export default config;

```


---

## `postcss.config.mjs`

```js
/** @type {import('postcss-load-config').Config} */
const config = {
  plugins: {
    tailwindcss: {},
  },
};

export default config;

```


---

## `src/app/globals.css`

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

/* ── Brand design tokens ───────────────────────────────────────────────────── */
:root {
  --background: #ffffff;
  --foreground: #09090b;
  /* Gold — amber accent (Implementation.html §01) */
  --gold: 217 119 6;        /* #d97706 as RGB for legacy rgb(var(--gold)/alpha) usage */
  --gold-hex: #d97706;
  --gold-dark: #b45309;     /* gold-2: text-safe amber on light backgrounds */
  --gold-soft: #fef3c7;
  /* Ink scale */
  --ink: #09090b;
  --ink-2: #27272a;
  --ink-3: #71717a;
  /* Borders */
  --line: #e4e4e7;
  --line-2: #d4d4d8;
  /* Surfaces */
  --bg: #fafaf9;
  --bg-2: #f4f4f5;
  /* Override Tailwind's global focus ring → brand gold */
  --tw-ring-color: rgb(217 119 6 / 0.45);
}

/* ── Base ──────────────────────────────────────────────────────────────────── */
body {
  color: var(--foreground);
  background: var(--background);
  font-family: var(--font-geist-sans, 'Geist', system-ui, sans-serif);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  font-feature-settings: 'ss01', 'cv11';
}

/* ── Scrollbar — subtle, premium ──────────────────────────────────────────── */
::-webkit-scrollbar { width: 5px; height: 5px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 99px; }
::-webkit-scrollbar-thumb:hover { background: #9ca3af; }

/* ── Selection color ───────────────────────────────────────────────────────── */
::selection { background: rgb(217 119 6 / 0.2); }

/* ── Animations ────────────────────────────────────────────────────────────── */
@keyframes slide-up {
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: translateY(0); }
}
.toast-enter { animation: slide-up 0.25s ease-out both; }

/* ── Gold gradient text utility ───────────────────────────────────────────── */
.text-gold-gradient {
  background: linear-gradient(135deg, #e8c97a 0%, #c9a84c 50%, #a88930 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

/* ── Safe area utilities ───────────────────────────────────────────────────── */
.pb-safe { padding-bottom: env(safe-area-inset-bottom, 0px); }
.pt-safe { padding-top: env(safe-area-inset-top, 0px); }
.px-safe { padding-left: env(safe-area-inset-left, 0px); padding-right: env(safe-area-inset-right, 0px); }

/* Mobile main content: offset for RC bar (40px) + status bar safe area */
@media (max-width: 767px) {
  .mobile-content-top {
    padding-top: calc(env(safe-area-inset-top, 0px) + 2.5rem);
  }
}

/* ── Design system primitives (Implementation.html §04) ───────────────────── */
@layer components {
  /* Card surfaces */
  .ui-card       { @apply bg-paper border border-line rounded-lg p-4; }
  .ui-card-dense { @apply bg-paper border border-line rounded-md px-3 py-2.5; }
  /* Type utilities */
  .ui-label { @apply font-mono text-label uppercase tracking-[0.08em] text-ink-3; }
  .ui-meta  { @apply font-mono text-[10.5px] text-ink-3; }
}

/* ── Text balance ──────────────────────────────────────────────────────────── */
@layer utilities {
  .text-balance { text-wrap: balance; }
}

/* ── Prevent iOS auto-zoom on input focus ──────────────────────────────────── */
@supports (-webkit-touch-callout: none) {
  input[type="text"],
  input[type="number"],
  input[type="email"],
  input[type="password"],
  input[type="date"],
  input[type="search"],
  textarea,
  select { font-size: 16px !important; }
}

/* ── Invoice image viewer — bbox highlight animation ─────────────────────── */
@keyframes bbox-pulse {
  0%   { opacity: 0; }
  15%  { opacity: 1; }
  60%  { opacity: 0.85; }
  100% { opacity: 0.4; }
}
.bbox-highlight { animation: bbox-pulse 1.4s ease-out forwards; }

@keyframes bbox-ring-pulse {
  0%   { stroke-width: 0.006; opacity: 0; }
  20%  { stroke-width: 0.008; opacity: 1; }
  80%  { stroke-width: 0.004; opacity: 0.8; }
  100% { stroke-width: 0.003; opacity: 0.6; }
}
.bbox-ring { animation: bbox-ring-pulse 1.4s ease-out forwards; }

/* ── Toast notification system ─────────────────────────────────────────────── */
@keyframes toast-in {
  from { transform: translateX(calc(100% + 24px)) scale(0.95); opacity: 0; }
  to   { transform: translateX(0) scale(1); opacity: 1; }
}

@keyframes toast-out {
  0%   { transform: translateX(0) scale(1); opacity: 1; max-height: 120px; margin-bottom: 0; }
  40%  { transform: translateX(60%) scale(0.9); opacity: 0; }
  100% { transform: translateX(60%) scale(0.9); opacity: 0; max-height: 0; margin-bottom: -10px; }
}

@keyframes toast-progress {
  from { width: 100%; }
  to   { width: 0%; }
}

.toast-item {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 16px 18px;
  background: rgba(22, 22, 22, 0.96);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.4), 0 2px 8px rgba(0,0,0,0.2);
  overflow: hidden;
  pointer-events: all;
  will-change: transform, opacity;
  /* Default: hidden */
  transform: translateX(calc(100% + 24px)) scale(0.95);
  opacity: 0;
  transition: none;
}

.toast-item--entering {
  /* same as default, animation fires on --visible */
}

.toast-item--visible {
  animation: toast-in 350ms cubic-bezier(0.21, 1.02, 0.73, 1) forwards;
}

.toast-item--exiting {
  animation: toast-out 320ms cubic-bezier(0.33, 0, 0.67, 0) forwards;
}

.toast-title {
  font-size: 13px;
  font-weight: 600;
  color: #fff;
  line-height: 1.3;
  margin-bottom: 2px;
}

.toast-message {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
  line-height: 1.45;
}

.toast-close {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  border-radius: 5px;
  color: rgba(255, 255, 255, 0.3);
  cursor: pointer;
  padding: 0;
  margin-top: -1px;
  transition: color 0.15s, background 0.15s;
}
.toast-close:hover {
  color: rgba(255, 255, 255, 0.8);
  background: rgba(255, 255, 255, 0.08);
}

.toast-progress {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: rgba(255, 255, 255, 0.06);
}

.toast-progress-fill {
  height: 100%;
  width: 100%;
  animation: toast-progress var(--duration, 5000ms) linear forwards;
}

@media (prefers-reduced-motion: reduce) {
  .toast-item,
  .toast-item--visible,
  .toast-item--exiting,
  .toast-progress-fill {
    animation: none !important;
    transition: none !important;
    transform: none !important;
    opacity: 1 !important;
  }
}

```


---

## `src/components/ui/index.ts`

```ts
export { HeroKPI }   from './HeroKPI'
export { KPI }       from './KPI'
export { Button }    from './Button'
export { Chip }      from './Chip'
export { ActionRow } from './ActionRow'
export { Alert }     from './Alert'
export { Pill }      from './Pill'
export { PageHeader } from './PageHeader'

```


---

## `src/components/ui/Button.tsx`

```tsx
import { ButtonHTMLAttributes } from 'react'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary'
}

export function Button({ variant = 'primary', className = '', children, ...props }: ButtonProps) {
  const base = 'inline-flex items-center gap-2 px-[18px] py-[11px] rounded-md text-body font-semibold transition-colors disabled:opacity-50'

  const styles =
    variant === 'primary'
      ? 'bg-ink text-paper hover:bg-ink-2'
      : 'bg-paper border border-line text-ink-2 hover:bg-bg-2'

  return (
    <button className={`${base} ${styles} ${className}`} {...props}>
      {children}
    </button>
  )
}

```


---

## `src/components/ui/PageHeader.tsx`

```tsx
import { ReactNode } from 'react'

interface PageHeaderProps {
  title: string
  meta?: string
  right?: ReactNode
  cost?: {
    value: number | null
    label?: string
  }
}

export function PageHeader({ title, meta, right, cost }: PageHeaderProps) {
  return (
    <div className="flex items-end justify-between gap-4 px-4 py-3">
      <div>
        <h1 className="text-[28px] font-semibold tracking-[-0.035em] leading-[1.05] text-ink">
          {title}
        </h1>
        {(meta || cost) && (
          <div className="flex items-center gap-3 mt-1">
            {meta && (
              <p className="font-mono text-[10.5px] uppercase tracking-wider text-ink-3">{meta}</p>
            )}
            {cost && cost.value !== null && (
              <span className="font-mono text-[10.5px] bg-gold-soft text-gold-2 px-2 py-0.5 rounded-full">
                {cost.label ?? 'FOOD COST'} {cost.value.toFixed(1)}%
              </span>
            )}
          </div>
        )}
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </div>
  )
}

```


---

## `src/components/ui/HeroKPI.tsx`

```tsx
interface HeroKPIProps {
  label: string
  value: string | number
  unit?: string
  context?: string
  className?: string
}

export function HeroKPI({ label, value, unit = '%', context, className = '' }: HeroKPIProps) {
  return (
    <div className={`bg-ink text-paper rounded-xl p-5 ${className}`}>
      <p className="ui-label text-zinc-400">{label}</p>
      <p className="text-[60px] font-semibold leading-none tracking-[-0.04em] mt-1">
        {value}<span className="text-gold">{unit}</span>
      </p>
      {context && (
        <p className="ui-meta text-zinc-400 mt-2">{context}</p>
      )}
    </div>
  )
}

```


---

## `src/components/ui/KPI.tsx`

```tsx
interface KPIProps {
  label: string
  value: string | number
  sub?: string
  tone?: 'default' | 'alert' | 'ok'
  className?: string
}

export function KPI({ label, value, sub, tone = 'default', className = '' }: KPIProps) {
  const valueColor =
    tone === 'alert' ? 'text-red-600' :
    tone === 'ok'    ? 'text-green-600' :
    'text-ink'

  return (
    <div className={`border border-line bg-paper rounded-md px-3.5 py-3 ${className}`}>
      <p className="ui-label">{label}</p>
      <p className={`text-[22px] font-semibold tracking-[-0.015em] mt-1 ${valueColor}`}>
        {value}
      </p>
      {sub && <p className="ui-meta mt-0.5">{sub}</p>}
    </div>
  )
}

```


---

## `src/components/ui/ActionRow.tsx`

```tsx
import { ReactNode } from 'react'

interface ActionRowProps {
  icon?: ReactNode
  title: string
  titleMeta?: string
  caption?: string
  tone?: 'default' | 'alert'
  right?: ReactNode
  onClick?: () => void
}

export function ActionRow({ icon, title, titleMeta, caption, tone = 'default', right, onClick }: ActionRowProps) {
  return (
    <div
      className="flex items-center justify-between px-3 py-[11px] border-b border-dashed border-line last:border-b-0 cursor-pointer hover:bg-bg transition-colors"
      onClick={onClick}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        {icon && (
          <div className="w-6 h-6 rounded-[6px] bg-bg-2 grid place-items-center font-mono text-[11px] text-ink-3 shrink-0">
            {icon}
          </div>
        )}
        <div className="min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className="text-body font-medium text-ink truncate">{title}</span>
            {titleMeta && <span className="ui-meta">{titleMeta}</span>}
          </div>
          {caption && (
            <p className={`ui-meta mt-0.5 ${tone === 'alert' ? 'text-red-600' : ''}`}>{caption}</p>
          )}
        </div>
      </div>
      {right ?? <span className="text-ink-3 text-lg ml-3 shrink-0">›</span>}
    </div>
  )
}

```


---

## `src/components/ui/Alert.tsx`

```tsx
import { ReactNode } from 'react'

interface AlertProps {
  title?: string
  children: ReactNode
  tone?: 'gold' | 'red' | 'green'
}

const TONE_STYLES = {
  gold:  { wrap: 'bg-gold-soft border-amber-300',   title: 'text-gold-2',  body: 'text-amber-900' },
  red:   { wrap: 'bg-red-50 border-red-200',         title: 'text-red-700', body: 'text-red-900' },
  green: { wrap: 'bg-green-50 border-green-200',     title: 'text-green-700', body: 'text-green-900' },
}

export function Alert({ title, children, tone = 'gold' }: AlertProps) {
  const s = TONE_STYLES[tone]
  return (
    <div className={`${s.wrap} border rounded-md p-3`}>
      {title && (
        <p className={`${s.title} font-mono text-label uppercase tracking-[0.04em] mb-1`}>{title}</p>
      )}
      <div className={`${s.body} text-body leading-relaxed`}>{children}</div>
    </div>
  )
}

```


---

## `src/components/ui/Chip.tsx`

```tsx
import { ButtonHTMLAttributes } from 'react'

interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean
}

export function Chip({ active, className = '', children, ...props }: ChipProps) {
  const styles = active
    ? 'bg-ink text-paper border-ink'
    : 'bg-paper border-line text-ink-2 hover:border-ink-3'

  return (
    <button
      className={`font-mono text-[11px] px-2.5 py-1.5 rounded-full border tracking-[0.02em] transition-colors ${styles} ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}

```


---

## `src/components/ui/Pill.tsx`

```tsx
import { ReactNode } from 'react'

interface PillProps {
  tone?: 'gold' | 'alert' | 'ok' | 'default'
  children: ReactNode
  className?: string
}

const TONE_STYLES = {
  gold:    'bg-gold-soft text-gold-2',
  alert:   'bg-red-100 text-red-800',
  ok:      'bg-green-100 text-green-800',
  default: 'bg-bg-2 text-ink-2',
}

export function Pill({ tone = 'default', children, className = '' }: PillProps) {
  return (
    <span className={`font-mono text-[10px] font-medium px-2 py-0.5 rounded-full ${TONE_STYLES[tone]} ${className}`}>
      {children}
    </span>
  )
}

```


---

## `src/app/layout.tsx`

```tsx
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
import { CostChromeGate } from '@/components/layout/CostChromeGate'
import { KeyboardShortcuts } from '@/components/layout/KeyboardShortcuts'
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
          <Navigation />
          <MobileRcBar />
          <GlobalSearch />
          <KeyboardShortcuts />
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

```


---

## `src/app/page.tsx`

```tsx
import { redirect } from 'next/navigation'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export const dynamic = 'force-dynamic'

/**
 * v2 root route — role-based landing.
 *  Admin / Manager → /pass  (the daily-briefing landing)
 *  Staff          → /count  (counters jump straight to the canonical mobile flow)
 *
 * Unauthenticated traffic is already redirected to /login by middleware.
 */
export default async function RootPage() {
  const cookieStore = cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll() { /* no-op — root route doesn't refresh tokens */ },
      },
    },
  )

  const { data: { user } } = await supabase.auth.getUser()
  const role = (user?.user_metadata?.role as string | undefined) ?? 'STAFF'

  redirect(role === 'STAFF' ? '/count' : '/pass')
}

```


---

## `src/app/loading.tsx`

```tsx
// Root loading — shown while the dashboard chunk loads
export default function Loading() {
  return (
    <div className="p-4 space-y-4 animate-pulse">
      <div className="h-8 bg-gray-100 rounded w-40" />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[1,2,3,4].map(i => <div key={i} className="h-24 bg-gray-100 rounded-xl" />)}
      </div>
      <div className="h-48 bg-gray-100 rounded-xl" />
      <div className="h-48 bg-gray-100 rounded-xl" />
    </div>
  )
}

```


---

## `src/components/Navigation.tsx`

```tsx
'use client'
import Link from 'next/link'
import Image from 'next/image'
import { usePathname, useRouter } from 'next/navigation'
import { useState, Suspense, useEffect } from 'react'
import {
  Sun, Package, FileText, Trash2, BarChart3,
  BookOpen, UtensilsCrossed, LayoutGrid,
  X, ShoppingBag, TrendingUp, Settings, ChefHat, Truck, LogOut,
  ClipboardList, Activity, Building2, Zap,
} from 'lucide-react'
import { AlertsBell } from '@/components/AlertsBell'
import { RcSelector } from '@/components/navigation/RcSelector'
import { useRc } from '@/contexts/RevenueCenterContext'
import { useUser } from '@/contexts/UserContext'
import { createClient } from '@/lib/supabase/client'

type NavItem = {
  href: string
  label: string
  icon: React.ComponentType<{ size?: number | string; color?: string }>
  exact?: boolean
  adminOnly?: boolean
  badgeKey?: 'invoicesReview' | 'priceAlerts'
}

type NavGroup = {
  label: string
  items: NavItem[]
}

const navGroups: NavGroup[] = [
  {
    label: 'TODAY',
    items: [
      { href: '/pass',  label: 'Pass',  icon: Sun },
      { href: '/prep',  label: 'Prep',  icon: ChefHat },
      { href: '/count', label: 'Count', icon: ClipboardList },
    ],
  },
  {
    label: 'INBOX',
    items: [
      { href: '/invoices', label: 'Invoices', icon: FileText, badgeKey: 'invoicesReview' },
    ],
  },
  {
    label: 'LIBRARY',
    items: [
      { href: '/inventory', label: 'Inventory', icon: Package },
      { href: '/recipes',   label: 'Recipes',   icon: BookOpen },
      { href: '/menu',      label: 'Menu',       icon: UtensilsCrossed },
    ],
  },
  {
    label: 'INSIGHTS',
    items: [
      { href: '/cost',     label: 'Cost',     icon: BarChart3 },
      { href: '/variance', label: 'Variance', icon: Activity },
      { href: '/signals',  label: 'Signals',  icon: Zap },
      { href: '/sales',                     label: 'Sales',    icon: ShoppingBag },
      { href: '/wastage',                   label: 'Wastage',  icon: Trash2 },
    ],
  },
]

const setupItems: NavItem[] = [
  { href: '/setup',                label: 'Setup',           icon: Settings, exact: true, adminOnly: true },
  { href: '/setup/suppliers',      label: 'Suppliers',       icon: Truck },
  { href: '/setup/revenue-centers',label: 'Revenue centers', icon: Building2 },
]

// Mobile bottom tabs — 2 left, center Pages button, 2 right
const mobileLeft: NavItem[] = [
  { href: '/pass', label: 'Pass', icon: Sun },
  { href: '/prep', label: 'Prep', icon: ChefHat },
]
const mobileRight: NavItem[] = [
  { href: '/count', label: 'Count', icon: ClipboardList },
  { href: '/invoices', label: 'Invoices', icon: FileText, badgeKey: 'invoicesReview' },
]

export function Navigation() {
  return (
    <Suspense fallback={null}>
      <NavigationInner />
    </Suspense>
  )
}

// ── User pill helpers (sidebar footer) ──────────────────────────────────────

function userInitials(name?: string | null, email?: string | null) {
  const base = (name || email || '').trim()
  if (!base) return '··'
  const parts = base.split(/\s+/).slice(0, 2)
  return parts.map(p => p[0]?.toUpperCase() ?? '').join('') || base.slice(0, 2).toUpperCase()
}

function UserAvatar() {
  const { user } = useUser()
  const initials = userInitials(user?.name, user?.email)
  return (
    <div className="w-7 h-7 rounded-full flex items-center justify-center font-semibold text-[11.5px] text-ink shrink-0"
      style={{ background: 'linear-gradient(135deg, #d97706, #b45309)' }}>
      {initials}
    </div>
  )
}

function UserName() {
  const { user } = useUser()
  const display = user?.name || user?.email?.split('@')[0] || 'You'
  return <span className="truncate">{display}</span>
}

function TenantName() {
  const { activeRc, revenueCenters } = useRc()
  const name = activeRc?.name ?? (revenueCenters.length > 0 ? 'All revenue centers' : 'Fergie’s')
  return <span className="truncate">{name.toLowerCase()}</span>
}

function NavigationInner() {
  const pathname  = usePathname()
  const router    = useRouter()
  const [moreOpen, setMoreOpen] = useState(false)
  const [inboxCounts, setInboxCounts] = useState({ invoicesReview: 0, priceAlerts: 0 })
  useRc()
  const { role } = useUser()

  // Poll inbox badge counts
  useEffect(() => {
    const fetchCounts = async () => {
      try {
        const data = await fetch('/api/invoices/kpis').then(r => r.ok ? r.json() : null)
        if (data) {
          setInboxCounts({
            invoicesReview: data.awaitingApprovalCount ?? 0,
            priceAlerts: data.priceAlertCount ?? 0,
          })
        }
      } catch {}
    }
    fetchCounts()
    const interval = setInterval(fetchCounts, 60_000)
    return () => clearInterval(interval)
  }, [])

  const isActive = (item: Pick<NavItem, 'href' | 'exact'>) =>
    pathname === item.href || (!item.exact && item.href !== '/' && pathname.startsWith(item.href + '/'))

  const getBadge = (key?: NavItem['badgeKey']) =>
    key ? inboxCounts[key] : 0

  async function handleLogout() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  const visibleSetupItems = setupItems.filter(i => !i.adminOnly || role === 'ADMIN')
  const allNavItems = navGroups.flatMap(g => g.items)
  const flankingHrefs = new Set([...mobileLeft, ...mobileRight].map(i => i.href))
  const moreIsActive = !([...flankingHrefs]).some(href =>
    pathname === href || (href !== '/' && pathname.startsWith(href + '/'))
  )

  return (
    <>
      {/* ── Desktop Sidebar (v2) ─────────────────────────────────── */}
      <aside
        className="hidden md:flex flex-col w-[240px] h-screen fixed left-0 top-0 z-40 px-[14px] py-[18px] gap-[18px] text-zinc-300"
        style={{ background: '#09090b' }}
      >
        {/* Brand + bell */}
        <div className="flex items-center justify-between px-1.5 pb-3">
          <Link href="/" className="flex items-center gap-[9px] text-[14px] font-semibold tracking-[-0.02em] text-[#fafaf9]">
            <span className="relative inline-block w-5 h-5 rounded-[6px] bg-paper">
              <span className="absolute inset-1 rounded-[3px] bg-gold" />
            </span>
            Controla OS
          </Link>
          <div className="[&>div>button]:text-zinc-500 [&>div>button:hover]:text-white">
            <AlertsBell />
          </div>
        </div>

        {/* Workspace switcher pill (RC selector) */}
        <div className="-mx-0.5">
          <RcSelector />
        </div>

        {/* Nav groups */}
        <nav className="flex-1 overflow-y-auto -mx-0.5 px-0.5 flex flex-col gap-[6px]">
          {navGroups.map(group => {
            const visibleItems = group.items.filter(i => !i.adminOnly || role === 'ADMIN')
            return (
              <div key={group.label} className="flex flex-col gap-[2px]">
                <p className="font-mono text-[10px] text-zinc-600 tracking-[0.02em] px-2 pt-1.5 pb-[6px]">
                  {group.label}
                </p>
                {visibleItems.map(item => {
                  const active = isActive(item)
                  const badge  = getBadge(item.badgeKey)
                  const { href, label, icon: Icon } = item
                  return (
                    <Link
                      key={`${href}-${label}`}
                      href={href}
                      className={`group flex items-center gap-[10px] px-[10px] py-2 rounded-lg text-[13.5px] font-medium tracking-[-0.005em] whitespace-nowrap transition-colors ${
                        active
                          ? 'bg-paper text-ink'
                          : 'text-zinc-300 hover:bg-[#18181b] hover:text-zinc-50'
                      }`}
                    >
                      <span className={active ? 'text-ink' : 'text-zinc-500 group-hover:text-zinc-300'}>
                        <Icon size={16} />
                      </span>
                      <span className="flex-1">{label}</span>
                      {badge > 0 && (
                        <span className={`font-mono text-[10px] px-[6px] py-[1px] rounded-full font-semibold leading-none tracking-normal ${
                          active ? 'bg-gold text-ink' : 'bg-gold text-ink'
                        }`}>
                          {badge > 99 ? '99+' : badge}
                        </span>
                      )}
                    </Link>
                  )
                })}
              </div>
            )
          })}

          {/* Setup group */}
          <div className="flex flex-col gap-[2px]">
            <p className="font-mono text-[10px] text-zinc-600 tracking-[0.02em] px-2 pt-1.5 pb-[6px]">
              SETUP
            </p>
            {visibleSetupItems.map(item => {
              const active = isActive(item)
              const { href, label, icon: Icon } = item
              return (
                <Link
                  key={href}
                  href={href}
                  className={`group flex items-center gap-[10px] px-[10px] py-2 rounded-lg text-[13.5px] font-medium tracking-[-0.005em] whitespace-nowrap transition-colors ${
                    active
                      ? 'bg-paper text-ink'
                      : 'text-zinc-300 hover:bg-[#18181b] hover:text-zinc-50'
                  }`}
                >
                  <span className={active ? 'text-ink' : 'text-zinc-500 group-hover:text-zinc-300'}>
                    <Icon size={16} />
                  </span>
                  {label}
                </Link>
              )
            })}
          </div>
        </nav>

        {/* User pill footer */}
        <div className="flex items-center gap-[10px] px-[10px] py-2 rounded-[10px] bg-[#18181b] border border-[#27272a]">
          <UserAvatar />
          <div className="min-w-0 flex-1 text-[12.5px] leading-tight text-[#fafaf9] font-medium truncate">
            <UserName />
            <small className="block font-mono text-[10.5px] text-zinc-500 font-normal tracking-normal mt-0.5">
              <TenantName />
            </small>
          </div>
          <button
            onClick={handleLogout}
            title="Log out"
            className="w-7 h-7 rounded-md flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/5 transition-colors"
          >
            <LogOut size={14} />
          </button>
        </div>
      </aside>

      {/* ── Mobile Bottom Tab Bar ──────────────────────────────── */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 pb-safe">
        <div className="relative flex items-end">
          <div
            className="absolute inset-x-0 bg-white border-t border-gray-100 shadow-[0_-1px_8px_rgba(0,0,0,0.06)]"
            style={{
              bottom: 'calc(-1 * env(safe-area-inset-bottom, 0px))',
              height: 'calc(4rem + env(safe-area-inset-bottom, 0px))',
            }}
          />

          {mobileLeft.map(item => {
            const active = isActive(item)
            const { href, label, icon: Icon } = item
            return (
              <Link key={href} href={href}
                className={`relative flex-1 flex flex-col items-center pt-2 pb-2 gap-0.5 transition-colors ${
                  active ? 'text-gold' : 'text-gray-400'
                }`}
              >
                <Icon size={22} />
                <span className="text-[10px]">{label}</span>
              </Link>
            )
          })}

          {/* Center Pages button */}
          <button
            onClick={() => setMoreOpen(true)}
            className="relative flex-1 flex flex-col items-center pb-2"
          >
            <div className={`-mt-5 w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg transition-colors ${
              moreIsActive ? 'bg-gray-700' : 'bg-gray-900'
            }`}>
              <LayoutGrid size={22} className="text-white" />
            </div>
            <span className={`text-[10px] mt-0.5 font-medium ${moreIsActive ? 'text-gray-700' : 'text-gray-500'}`}>
              Pages
            </span>
          </button>

          {mobileRight.map(item => {
            const active = isActive(item)
            const badge  = getBadge(item.badgeKey)
            const { href, label, icon: Icon } = item
            return (
              <Link key={`mob-${href}-${label}`} href={href}
                className={`relative flex-1 flex flex-col items-center pt-2 pb-2 gap-0.5 transition-colors ${
                  active ? 'text-gold' : 'text-gray-400'
                }`}
              >
                <div className="relative">
                  <Icon size={22} />
                  {badge > 0 && (
                    <span className="absolute -top-1 -right-1.5 w-4 h-4 bg-gold text-[#111] text-[8px] font-bold rounded-full flex items-center justify-center leading-none">
                      {badge > 9 ? '9+' : badge}
                    </span>
                  )}
                </div>
                <span className="text-[10px]">{label}</span>
              </Link>
            )
          })}
        </div>
      </nav>

      {/* ── Mobile Pages Drawer ────────────────────────────────── */}
      {moreOpen && (
        <div className="md:hidden fixed inset-0 z-[60] flex flex-col bg-white">
          <div
            className="flex items-center justify-between px-5 pb-4 border-b border-gray-100"
            style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 1.25rem)' }}
          >
            <div>
              <h2 className="text-base font-bold text-gray-900">All Pages</h2>
              <p className="text-xs text-gray-400 mt-0.5">CONTROLA OS</p>
            </div>
            <button
              onClick={() => setMoreOpen(false)}
              className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-500 hover:bg-gray-200 transition-colors"
            >
              <X size={16} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-5">
            {navGroups.map(group => {
              const visibleItems = group.items.filter(i => !i.adminOnly || role === 'ADMIN')
              return (
                <div key={group.label}>
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1 px-3">
                    {group.label}
                  </p>
                  <div className="space-y-0.5">
                    {visibleItems.map(item => {
                      const active = isActive(item)
                      const badge  = getBadge(item.badgeKey)
                      const { href, label, icon: Icon } = item
                      return (
                        <Link
                          key={`drawer-${href}-${label}`}
                          href={href}
                          onClick={() => setMoreOpen(false)}
                          style={active ? {
                            borderLeftColor: '#c9a84c',
                            borderLeftWidth: 3,
                            backgroundColor: 'rgba(201,168,76,0.10)',
                          } : undefined}
                          className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-colors ${
                            active
                              ? 'text-gray-900 font-semibold pl-[10px]'
                              : 'text-gray-600 hover:bg-gray-50 font-normal'
                          }`}
                        >
                          <Icon size={18} color={active ? '#1f2937' : '#9ca3af'} />
                          <span className="flex-1">{label}</span>
                          {badge > 0 && (
                            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-gold/20 text-amber-700 min-w-[18px] text-center leading-none">
                              {badge > 99 ? '99+' : badge}
                            </span>
                          )}
                        </Link>
                      )
                    })}
                  </div>
                </div>
              )
            })}

            {/* Setup group in drawer */}
            <div>
              <p className="text-[10px] font-semibold text-gray-300 uppercase tracking-widest mb-1 px-3">
                SETUP
              </p>
              <div className="space-y-0.5">
                {visibleSetupItems.map(item => {
                  const active = isActive(item)
                  const { href, label, icon: Icon } = item
                  return (
                    <Link
                      key={href}
                      href={href}
                      onClick={() => setMoreOpen(false)}
                      className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-colors opacity-60 ${
                        active
                          ? 'text-gray-900 font-medium opacity-100'
                          : 'text-gray-500 hover:bg-gray-50'
                      }`}
                    >
                      <Icon size={16} color="#9ca3af" />
                      {label}
                    </Link>
                  )
                })}
              </div>
            </div>
          </div>

          <div className="border-t border-gray-100 px-3 py-3 pb-safe space-y-1">
            <button
              onClick={() => { setMoreOpen(false); handleLogout() }}
              className="flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-sm text-gray-500 hover:bg-gray-50 transition-colors"
            >
              <LogOut size={18} className="text-gray-400" />
              Log Out
            </button>
            <p className="text-xs text-gray-300 px-3">v1.0.0</p>
          </div>
        </div>
      )}
    </>
  )
}

// Keep the previous flat navItems export in case anything imports from here
// (AlertsBell, breadcrumbs, etc.) — remove once confirmed nothing uses it.
const _allNavItems = navGroups.flatMap(g => g.items)
export { _allNavItems as navItems }

```


---

## `src/components/navigation/RcSelector.tsx`

```tsx
'use client'
import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { ChevronDown, Check, Settings2, LayoutGrid } from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { rcHex } from '@/lib/rc-colors'

export function RcSelector() {
  const { revenueCenters, activeRcId, activeRc, setActiveRcId } = useRc()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  if (revenueCenters.length === 0) return null

  const isAll = activeRcId === null
  const hex = activeRc ? rcHex(activeRc.color) : '#6b7280'

  return (
    <div ref={ref} className="relative px-3 py-2 border-b border-gray-700">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 pl-3 pr-2 py-2 rounded-lg transition-colors text-left overflow-hidden relative"
        style={isAll
          ? { backgroundColor: 'rgb(31 41 55)' } // gray-800
          : { backgroundColor: `${hex}22`, borderLeft: `4px solid ${hex}` }
        }
      >
        {isAll
          ? <LayoutGrid size={13} className="text-gray-400 shrink-0" />
          : null
        }
        <span className="flex-1 text-sm font-medium truncate" style={{ color: isAll ? '#d1d5db' : hex }}>
          {isAll ? 'All Revenue Centers' : activeRc?.name}
        </span>
        <ChevronDown size={14} className="text-gray-400 shrink-0" />
      </button>

      {open && (
        <div className="absolute left-3 right-3 top-full mt-1 bg-gray-800 border border-gray-700 rounded-xl shadow-xl z-50 overflow-hidden">
          <button
            onClick={() => { setActiveRcId(null); setOpen(false) }}
            className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-700 transition-colors text-left"
          >
            <LayoutGrid size={10} className="text-gray-400 shrink-0" />
            <span className="flex-1 text-sm text-gray-100 truncate">All Revenue Centers</span>
            {isAll && <Check size={14} className="text-blue-400" />}
          </button>
          <div className="border-t border-gray-700" />
          {revenueCenters.map(rc => (
            <button
              key={rc.id}
              onClick={() => { setActiveRcId(rc.id); setOpen(false) }}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-700 transition-colors text-left"
            >
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: rcHex(rc.color) }} />
              <span className="flex-1 text-sm text-gray-100 truncate">{rc.name}</span>
              {rc.id === activeRcId && <Check size={14} className="text-blue-400" />}
            </button>
          ))}
          <div className="border-t border-gray-700 p-1">
            <Link
              href="/revenue-centers"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-700 transition-colors"
            >
              <Settings2 size={12} />
              Manage Revenue Centers
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}

```


---

## `src/components/navigation/MobileRcBar.tsx`

```tsx
'use client'
import { useState } from 'react'
import { ChevronDown, Check, LayoutGrid } from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { rcHex } from '@/lib/rc-colors'
import { AlertsBell } from '@/components/AlertsBell'

export function MobileRcBar() {
  const { revenueCenters, activeRcId, activeRc, setActiveRcId } = useRc()
  const [open, setOpen] = useState(false)

  if (revenueCenters.length === 0) return null

  const isAll = activeRcId === null
  const hex = activeRc ? rcHex(activeRc.color) : '#6b7280'

  return (
    <>
      <div
        className="md:hidden fixed top-0 left-0 right-0 z-40 bg-white border-b border-gray-100 flex flex-col"
        style={{ borderLeftColor: hex, borderLeftWidth: 3 }}
      >
        {/* Status bar spacer */}
        <div className="pt-safe" />
        <div className="flex items-center justify-between px-4 h-10">
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-2 text-sm font-medium text-gray-700"
        >
          {isAll
            ? <LayoutGrid size={14} className="text-gray-400 shrink-0" />
            : <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: hex }} />
          }
          {isAll ? 'All Revenue Centers' : activeRc?.name}
          <ChevronDown size={14} className="text-gray-400" />
        </button>
          <AlertsBell dropdownAlign="right" />
        </div>
      </div>

      {open && (
        <>
          <div className="md:hidden fixed inset-0 bg-black/40 z-[60]" onClick={() => setOpen(false)} />
          <div className="md:hidden fixed bottom-0 left-0 right-0 bg-white rounded-t-2xl z-[70] shadow-xl pb-safe">
            <div className="px-5 pt-4 pb-2 text-sm font-semibold text-gray-700">Revenue Center</div>
            <div className="px-4 pb-8 space-y-1">
              <button
                onClick={() => { setActiveRcId(null); setOpen(false) }}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-gray-50 transition-colors"
              >
                <LayoutGrid size={16} className="text-gray-400 shrink-0" />
                <span className="flex-1 text-sm text-gray-800 text-left">All Revenue Centers</span>
                {isAll && <Check size={16} className="text-blue-500" />}
              </button>
              {revenueCenters.map(rc => (
                <button
                  key={rc.id}
                  onClick={() => { setActiveRcId(rc.id); setOpen(false) }}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-gray-50 transition-colors"
                >
                  <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: rcHex(rc.color) }} />
                  <span className="flex-1 text-sm text-gray-800 text-left">{rc.name}</span>
                  {rc.id === activeRcId && <Check size={16} className="text-blue-500" />}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  )
}

```


---

## `src/components/layout/CostChrome.tsx`

```tsx
'use client'
import { useEffect, useState } from 'react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { SpineAuditDrawer } from './SpineAuditDrawer'

/**
 * Dark live food-cost % strip — Principle 01 of Controla OS.
 * Fetches /api/insights/cost-chrome every 60s; refetches on RC change.
 * Phase 3 will add the click-through audit drawer.
 */

interface ChromeData {
  foodCostPct: number | null
  targetPct: number
  variance7d: number | null
  onHand: number
  lastInvoiceAt: string | null
  lastInvoiceSupplier: string | null
  sourceItemCount: number
}

export function CostChrome() {
  const { activeRcId } = useRc()
  const [data, setData] = useState<ChromeData | null>(null)
  const [loading, setLoading] = useState(true)
  const [auditOpen, setAuditOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    const fetchData = async () => {
      try {
        const qs = activeRcId ? `?rcId=${activeRcId}` : ''
        const res = await fetch(`/api/insights/cost-chrome${qs}`, { cache: 'no-store' })
        if (!res.ok) return
        const json = await res.json()
        if (!cancelled) { setData(json); setLoading(false) }
      } catch { /* swallow — strip stays in last-known state */ }
    }
    fetchData()
    const i = setInterval(fetchData, 60_000)
    return () => { cancelled = true; clearInterval(i) }
  }, [activeRcId])

  const fcPct = data?.foodCostPct ?? null
  const fcClass = fcPct === null
    ? ''
    : fcPct < (data?.targetPct ?? 27)
      ? 'text-green-400'
      : fcPct < (data?.targetPct ?? 27) + 2
        ? 'text-amber-300'
        : 'text-red-300'

  const v7d = data?.variance7d ?? null

  return (
    <div className="hidden md:flex bg-ink text-paper px-8 py-[10px] items-center gap-6 border-b border-ink">
      <CCItem
        label="Food cost · live"
        value={loading ? '…' : fmtPct(fcPct)}
        valueClass={fcClass}
      />
      <CCDivider />
      <CCItem
        label="Target"
        value={loading ? '…' : fmtPct(data?.targetPct ?? null)}
      />
      <CCDivider />
      <CCItem
        label="7d variance"
        value={loading ? '…' : fmtMoneySigned(v7d)}
        valueClass={v7d !== null && v7d > 0 ? 'text-red-300' : v7d !== null && v7d < 0 ? 'text-green-400' : ''}
      />
      <CCDivider />
      <CCItem
        label="On hand"
        value={loading ? '…' : fmtMoney(data?.onHand ?? null)}
      />
      <div className="flex-1" />
      <span className="font-mono text-[10.5px] text-zinc-500">
        computed from{' '}
        <button
          onClick={() => setAuditOpen(true)}
          className="text-gold border-b border-dashed border-gold/60 hover:text-gold/80 transition-colors"
          title={data ? `${data.sourceItemCount} inventory items — click for audit` : 'pricePerBaseUnit spine'}
        >
          pricePerBaseUnit
        </button>
        {data?.lastInvoiceAt && (
          <> · last invoice {humanizeAge(data.lastInvoiceAt)}</>
        )}
      </span>
      <SpineAuditDrawer open={auditOpen} onClose={() => setAuditOpen(false)} />
    </div>
  )
}

function CCItem({ label, value, valueClass = '' }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="font-mono text-[10px] text-zinc-500 uppercase tracking-[0.02em]">{label}</span>
      <span className={`font-mono text-[14px] font-semibold tracking-[-0.01em] ${valueClass || 'text-paper'}`}>
        {value}
      </span>
    </div>
  )
}

function CCDivider() {
  return <div className="w-px h-[14px] bg-zinc-800" />
}

// ── Formatters ──────────────────────────────────────────────────────────────

function fmtPct(n: number | null): string {
  if (n === null || Number.isNaN(n)) return '—'
  return `${n.toFixed(1)}%`
}

function fmtMoney(n: number | null): string {
  if (n === null || Number.isNaN(n)) return '—'
  return '$' + Math.round(n).toLocaleString()
}

function fmtMoneySigned(n: number | null): string {
  if (n === null || Number.isNaN(n)) return '—'
  if (n === 0) return '$0'
  const sign = n > 0 ? '+' : '−'
  return `${sign}$${Math.round(Math.abs(n)).toLocaleString()}`
}

function humanizeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.round(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}

```


---

## `src/components/layout/CostChromeGate.tsx`

```tsx
'use client'
import { usePathname } from 'next/navigation'
import { CostChrome } from './CostChrome'

/**
 * Mount CostChrome only on routes that touch the spine
 * (recipes / menu / invoices / count / prep / pass / insights).
 * Auth + setup routes don't get the strip.
 */
const SPINE_ROUTES = [
  '/',
  '/pass',
  '/prep',
  '/count',
  '/inventory',
  '/recipes',
  '/menu',
  '/invoices',
  '/cost',
  '/variance',
  '/signals',
  '/sales',
  '/wastage',
]

const HIDDEN_PREFIXES = [
  '/login',
  '/auth',
  '/setup',
  '/settings', // legacy; middleware redirects but cover it just in case
]

export function CostChromeGate() {
  const pathname = usePathname()
  if (!pathname) return null
  if (HIDDEN_PREFIXES.some(p => pathname === p || pathname.startsWith(p + '/'))) return null
  const onSpine = SPINE_ROUTES.some(p => pathname === p || pathname.startsWith(p + '/'))
  if (!onSpine) return null
  return <CostChrome />
}

```


---

## `src/components/layout/SpineAuditDrawer.tsx`

```tsx
'use client'
import { useEffect, useState } from 'react'
import { X, ExternalLink, AlertCircle, Clock } from 'lucide-react'
import Link from 'next/link'

interface SpineAuditData {
  summary: {
    totalItems: number
    totalValue: number
    zeroPriceCount: number
    staleCount: number
  }
  topItems: Array<{
    id: string
    name: string
    category: string
    baseUnit: string
    pricePerBaseUnit: number
    stockOnHand: number
    inventoryValue: number
    supplier: string | null
    lastUpdated: string | null
  }>
  recentInvoices: Array<{
    id: string
    supplier: string | null
    invoiceNumber: string | null
    approvedAt: string | null
    total: number | null
    lineCount: number
  }>
  recentPrepSyncs: Array<{
    id: string
    itemName: string
    recipeId: string | null
    recipeName: string | null
    pricePerBaseUnit: number
    lastUpdated: string | null
  }>
}

interface SpineAuditDrawerProps {
  open: boolean
  onClose: () => void
}

export function SpineAuditDrawer({ open, onClose }: SpineAuditDrawerProps) {
  const [data, setData] = useState<SpineAuditData | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    fetch('/api/insights/spine-audit', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(json => { if (json) setData(json) })
      .finally(() => setLoading(false))
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[80] flex">
      <div className="flex-1 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <aside className="w-full md:w-[640px] bg-paper h-full overflow-y-auto flex flex-col shadow-2xl">
        <header className="sticky top-0 bg-paper z-10 border-b border-line px-6 py-4 flex items-center gap-3">
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-[8px] border border-line flex items-center justify-center text-ink-2 hover:border-ink-3 transition-colors"
          >
            <X size={16} />
          </button>
          <div className="flex-1 min-w-0">
            <div className="font-mono text-[10.5px] text-ink-3 uppercase tracking-[0.04em]">Spine audit</div>
            <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-ink leading-tight">
              <span className="font-mono text-gold-2">pricePerBaseUnit</span> — provenance
            </h2>
          </div>
        </header>

        {loading && !data ? (
          <div className="flex-1 flex items-center justify-center text-ink-3 font-mono text-[11px]">Loading…</div>
        ) : !data ? (
          <div className="flex-1 flex items-center justify-center text-ink-3 font-mono text-[11px]">Failed to load</div>
        ) : (
          <div className="flex-1 px-6 py-5 space-y-6">
            {/* Summary */}
            <section className="grid grid-cols-2 gap-3">
              <SummaryCard label="Total inventory value" value={fmtMoney(data.summary.totalValue)} />
              <SummaryCard label="Active items" value={data.summary.totalItems.toString()} />
              <SummaryCard
                label="Zero-price items"
                value={data.summary.zeroPriceCount.toString()}
                tint={data.summary.zeroPriceCount > 0 ? 'warn' : 'neutral'}
                hint={data.summary.zeroPriceCount > 0 ? 'need pricing' : 'all priced'}
              />
              <SummaryCard
                label="Stale prices (>30d)"
                value={data.summary.staleCount.toString()}
                tint={data.summary.staleCount > 0 ? 'warn' : 'neutral'}
                hint={data.summary.staleCount > 0 ? 'consider recount' : 'fresh'}
              />
            </section>

            {/* Top items */}
            <section>
              <SectionHead label="Top items by value">
                Driving <b className="text-ink">{Math.round((sumTop(data.topItems) / Math.max(1, data.summary.totalValue)) * 100)}%</b> of on-hand
              </SectionHead>
              <div className="border border-line rounded-[10px] overflow-hidden bg-paper">
                {data.topItems.map(it => (
                  <Link
                    key={it.id}
                    href={`/inventory?highlight=${it.id}`}
                    onClick={onClose}
                    className="grid grid-cols-[1fr_auto_auto] gap-3 items-center px-4 py-2.5 border-b border-line last:border-0 hover:bg-bg-2/60 transition-colors"
                  >
                    <div className="min-w-0">
                      <div className="text-[13px] text-ink font-medium truncate">{it.name}</div>
                      <div className="font-mono text-[10.5px] text-ink-3">{it.category}{it.supplier ? ` · ${it.supplier}` : ''}</div>
                    </div>
                    <div className="font-mono text-[11px] text-ink-3 text-right whitespace-nowrap">
                      {it.stockOnHand.toFixed(1)} {it.baseUnit} × {fmtMoney(it.pricePerBaseUnit, true)}
                    </div>
                    <div className="font-mono text-[13px] text-ink font-medium tracking-[-0.01em] text-right tabular-nums w-20">
                      {fmtMoney(it.inventoryValue)}
                    </div>
                  </Link>
                ))}
                {data.topItems.length === 0 && <Empty>No items yet — import inventory to populate the spine.</Empty>}
              </div>
            </section>

            {/* Recent invoice approvals */}
            <section>
              <SectionHead label="Recent invoice approvals">
                Each approval writes <span className="font-mono text-gold-2">pricePerBaseUnit</span> for matched lines
              </SectionHead>
              <div className="border border-line rounded-[10px] overflow-hidden bg-paper">
                {data.recentInvoices.map(inv => (
                  <Link
                    key={inv.id}
                    href={`/invoices/${inv.id}`}
                    onClick={onClose}
                    className="grid grid-cols-[1fr_auto_auto] gap-3 items-center px-4 py-2.5 border-b border-line last:border-0 hover:bg-bg-2/60 transition-colors"
                  >
                    <div className="min-w-0">
                      <div className="text-[13px] text-ink font-medium truncate flex items-center gap-1.5">
                        {inv.supplier ?? 'Unknown supplier'} <ExternalLink size={11} className="text-ink-4" />
                      </div>
                      <div className="font-mono text-[10.5px] text-ink-3">
                        {inv.invoiceNumber ?? '—'} · {inv.lineCount} lines · {humanizeAge(inv.approvedAt)}
                      </div>
                    </div>
                    <div className="font-mono text-[13px] text-ink font-medium tabular-nums">
                      {inv.total !== null ? fmtMoney(inv.total) : '—'}
                    </div>
                  </Link>
                ))}
                {data.recentInvoices.length === 0 && <Empty>No approved invoices yet.</Empty>}
              </div>
            </section>

            {/* PREP syncs */}
            <section>
              <SectionHead label="Recent PREP syncs">
                Recipes that re-cost themselves into the spine via <span className="font-mono text-gold-2">syncPrepToInventory</span>
              </SectionHead>
              <div className="border border-line rounded-[10px] overflow-hidden bg-paper">
                {data.recentPrepSyncs.map(p => (
                  <div
                    key={p.id}
                    className="grid grid-cols-[1fr_auto] gap-3 items-center px-4 py-2.5 border-b border-line last:border-0"
                  >
                    <div className="min-w-0">
                      <div className="text-[13px] text-ink font-medium truncate">{p.itemName}</div>
                      <div className="font-mono text-[10.5px] text-ink-3">
                        from {p.recipeName ?? '—'} · {humanizeAge(p.lastUpdated)}
                      </div>
                    </div>
                    <div className="font-mono text-[13px] text-ink font-medium tabular-nums">
                      {fmtMoney(p.pricePerBaseUnit, true)} / unit
                    </div>
                  </div>
                ))}
                {data.recentPrepSyncs.length === 0 && <Empty>No PREP recipes linked to inventory yet.</Empty>}
              </div>
            </section>

            <p className="font-mono text-[10.5px] text-ink-3 pt-2 border-t border-line">
              The spine is a single Decimal column on InventoryItem.
              Read by recipes, menu, prep, count, sales, variance, cost-chrome.
              Written only by: invoice approve, syncPrepToInventory, manual override, inventory-import, repair-prices.
            </p>
          </div>
        )}
      </aside>
    </div>
  )
}

function SummaryCard({ label, value, tint = 'neutral', hint }: {
  label: string; value: string; tint?: 'neutral' | 'warn'; hint?: string
}) {
  const tintCls = tint === 'warn' ? 'bg-gold-soft border-[#fcd34d] text-gold-2' : 'bg-bg-2 border-line text-ink'
  return (
    <div className={`border rounded-[10px] p-3 ${tintCls}`}>
      <div className="font-mono text-[9.5px] uppercase tracking-[0.04em] opacity-70">{label}</div>
      <div className={`font-mono text-[18px] font-semibold tracking-[-0.02em] mt-1 ${tint === 'warn' ? 'text-gold-2' : 'text-ink'}`}>{value}</div>
      {hint && <div className="font-mono text-[10px] opacity-70 mt-0.5">{hint}</div>}
    </div>
  )
}

function SectionHead({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between mb-2 px-1">
      <h3 className="text-[13px] font-semibold text-ink tracking-[-0.01em]">{label}</h3>
      <p className="font-mono text-[10.5px] text-ink-3 text-right [&_b]:text-ink [&_b]:font-medium">{children}</p>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-6 text-center font-mono text-[11px] text-ink-3">{children}</div>
}

function fmtMoney(n: number, fine = false): string {
  if (n === 0) return '$0'
  if (fine && n < 1) return '$' + n.toFixed(4)
  return '$' + Math.round(n).toLocaleString()
}

function humanizeAge(iso: string | null): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.round(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}

function sumTop(items: SpineAuditData['topItems']): number {
  return items.reduce((s, it) => s + it.inventoryValue, 0)
}

// Re-export icons to suppress unused warnings (they're available for future enrichment)
export const _audit_icons = { AlertCircle, Clock }

```


---

## `src/components/layout/SubNav.tsx`

```tsx
'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

export interface SubNavTab {
  href: string
  label: string
  icon?: ReactNode
  exact?: boolean
}

interface SubNavProps {
  tabs: SubNavTab[]
  right?: ReactNode
}

/**
 * Per-page sub-nav strip (paper bg, gold underline on active).
 * Sits under the cost-chrome slot and above the page body.
 * Match: mock app/styles.css `.subnav`.
 */
export function SubNav({ tabs, right }: SubNavProps) {
  const pathname = usePathname()

  const isActive = (t: SubNavTab) =>
    t.exact || t.href === '/'
      ? pathname === t.href
      : pathname === t.href || pathname.startsWith(t.href + '/')

  return (
    <nav className="hidden md:flex items-stretch gap-0 px-8 bg-paper border-b border-line h-12">
      {tabs.map(tab => {
        const active = isActive(tab)
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`flex items-center gap-[7px] px-[18px] text-[13.5px] font-medium tracking-[-0.005em] whitespace-nowrap border-b-2 transition-colors ${
              active
                ? 'border-gold text-ink'
                : 'border-transparent text-ink-3 hover:text-ink-2'
            }`}
          >
            {tab.icon}
            {tab.label}
          </Link>
        )
      })}
      {right !== undefined && (
        <div className="ml-auto flex items-center gap-2 py-[9px]">{right}</div>
      )}
      {right === undefined && (
        <div className="ml-auto flex items-center gap-2 py-[9px]">
          <kbd className="font-mono text-[10.5px] text-ink-3 bg-bg-2 border border-line rounded-md px-[7px] py-[3px]">⌘ K</kbd>
        </div>
      )}
    </nav>
  )
}

```


---

## `src/components/layout/PageHead.tsx`

```tsx
import type { ReactNode } from 'react'

interface PageHeadProps {
  /** Mono breadcrumb line, e.g. "LIBRARY / INVENTORY". Optional icon + text. */
  crumbs?: ReactNode
  /** Display title — Geist 600 36px tight. */
  title: ReactNode
  /** One-line sub. Use <b> for emphasis. */
  sub?: ReactNode
  /** Right-aligned button group (e.g. <PageActions />). */
  actions?: ReactNode
  /** Override default bottom margin (24px). */
  className?: string
}

/**
 * Standard page header. Pattern from app/styles.css `.head`.
 * Pages opt in — does not auto-mount.
 */
export function PageHead({ crumbs, title, sub, actions, className = '' }: PageHeadProps) {
  return (
    <div className={`flex justify-between items-end gap-6 mb-6 flex-wrap ${className}`}>
      <div className="min-w-0 flex-1">
        {crumbs && (
          <div className="font-mono text-[10.5px] text-ink-3 mb-[10px] tracking-[0] flex items-center gap-2">
            {crumbs}
          </div>
        )}
        <h1 className="text-[36px] font-semibold tracking-[-0.04em] leading-none mb-1.5 text-ink">
          {title}
        </h1>
        {sub && (
          <p className="text-[13.5px] text-ink-3 tracking-[-0.005em] [&_b]:text-ink [&_b]:font-medium">
            {sub}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex gap-2 items-center shrink-0">
          {actions}
        </div>
      )}
    </div>
  )
}

```


---

## `src/components/layout/EditorDrawer.tsx`

```tsx
'use client'
import { useEffect, type ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'

interface EditorDrawerProps {
  /** Optional dark cost-strip slot rendered under the title bar. */
  costStrip?: ReactNode
  /** Title bar slot — left of the back button is rendered here. */
  titleBar: ReactNode
  /** Main scrollable content. */
  children: ReactNode
  /** ESC + overlay click → call onClose. */
  onClose: () => void
  /** Width preset. Defaults to "default" (640px). */
  width?: 'default' | 'wide'
  /** Tailwind z-index. Default z-[60]. */
  zClassName?: string
}

/**
 * Generic right-side editor drawer. Shared chrome:
 * - Fixed inset overlay with backdrop click-to-close
 * - Sticky title bar with back-button slot for actions
 * - Optional cost-strip slot directly under the title bar (Principle 01)
 * - Scrollable body
 *
 * Used by RecipePanel + future Menu / Inventory item editors.
 * Mock reference: app/Recipes.html + app/Menu.html drawer pattern.
 */
export function EditorDrawer({
  costStrip,
  titleBar,
  children,
  onClose,
  width = 'default',
  zClassName = 'z-[60]',
}: EditorDrawerProps) {

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const w = width === 'wide' ? 'md:w-[880px] xl:w-[1080px]' : 'md:w-[640px]'

  return (
    <div className={`fixed inset-0 ${zClassName} flex`}>
      <div className="flex-1 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className={`w-full ${w} bg-bg h-full overflow-y-auto flex flex-col shadow-2xl`}>
        <div className="sticky top-0 z-10 bg-paper">
          <div
            className="border-b border-line px-5 py-4 flex items-center gap-3"
            style={{ paddingTop: 'calc(1rem + env(safe-area-inset-top, 0px))' }}
          >
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-[8px] border border-line flex items-center justify-center text-ink-2 hover:border-ink-3 transition-colors bg-paper shrink-0"
              aria-label="Close"
            >
              <ArrowLeft size={16} />
            </button>
            <div className="flex-1 min-w-0 flex items-center gap-3">
              {titleBar}
            </div>
          </div>
          {costStrip}
        </div>
        {children}
      </div>
    </div>
  )
}

```


---

## `src/components/layout/KeyboardShortcuts.tsx`

```tsx
'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Global keyboard shortcuts:
 *   ⌘1 → /pass        (Today)
 *   ⌘2 → /invoices    (Inbox)
 *   ⌘3 → /inventory   (Library)
 *   ⌘4 → /cost        (Insights)
 *   ⌘5 → /setup       (Setup)
 *
 * ⌘K is owned by GlobalSearch.
 */
const ROUTES: Record<string, string> = {
  '1': '/pass',
  '2': '/invoices',
  '3': '/inventory',
  '4': '/cost',
  '5': '/setup',
}

export function KeyboardShortcuts() {
  const router = useRouter()
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      // Avoid stealing browser-native chord/save/etc
      if (e.shiftKey || e.altKey) return
      // Don't fire if user is typing in an input
      const t = e.target as HTMLElement | null
      if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return
      if (t?.isContentEditable) return
      const dest = ROUTES[e.key]
      if (dest) {
        e.preventDefault()
        router.push(dest)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [router])
  return null
}

```


---

## `src/contexts/UserContext.tsx`

```tsx
'use client'
import { createContext, useContext, useState, useEffect, useCallback } from 'react'

export type UserRole = 'ADMIN' | 'MANAGER' | 'STAFF'

export interface CurrentUser {
  id: string
  email: string
  name: string | null
  role: UserRole
}

interface UserContextValue {
  user: CurrentUser | null
  role: UserRole | null
  loading: boolean
  reload: () => Promise<void>
}

const UserContext = createContext<UserContextValue>({
  user: null,
  role: null,
  loading: true,
  reload: async () => {},
})

export function UserProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/me')
      if (res.ok) {
        const data: CurrentUser = await res.json()
        setUser(data)
      } else {
        setUser(null)
      }
    } catch {
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <UserContext.Provider value={{ user, role: user?.role ?? null, loading, reload: load }}>
      {children}
    </UserContext.Provider>
  )
}

export const useUser = () => useContext(UserContext)

```


---

## `src/contexts/RevenueCenterContext.tsx`

```tsx
'use client'
import { createContext, useContext, useState, useEffect, useCallback } from 'react'

export interface RevenueCenter {
  id: string
  name: string
  color: string
  isDefault: boolean
  isActive: boolean
  type: string
  description: string | null
  managerName: string | null
  targetFoodCostPct: string | null  // Prisma Decimal → string in JSON
  notes: string | null
  createdAt: string
}

interface RcContextValue {
  revenueCenters: RevenueCenter[]
  activeRcId: string | null
  activeRc: RevenueCenter | null
  setActiveRcId: (id: string | null) => void
  reload: () => Promise<void>
}

const RcContext = createContext<RcContextValue>({
  revenueCenters: [],
  activeRcId: null,
  activeRc: null,
  setActiveRcId: () => {},
  reload: async () => {},
})

export function RcProvider({ children }: { children: React.ReactNode }) {
  const [revenueCenters, setRevenueCenters] = useState<RevenueCenter[]>([])
  const [activeRcId, setActiveRcIdState] = useState<string | null>(null)

  const load = useCallback(async () => {
    const data: RevenueCenter[] = await fetch('/api/revenue-centers').then(r => r.json())
    setRevenueCenters(data)
    setActiveRcIdState(prev => {
      const stored = typeof window !== 'undefined' ? localStorage.getItem('activeRcId') : null
      if (stored === 'all') return null
      if (stored && data.find(rc => rc.id === stored)) return stored
      return data.find(rc => rc.isDefault)?.id ?? data[0]?.id ?? null
    })
  }, [])

  useEffect(() => { load() }, [load])

  const setActiveRcId = (id: string | null) => {
    setActiveRcIdState(id)
    if (typeof window !== 'undefined') {
      if (id) localStorage.setItem('activeRcId', id)
      else localStorage.setItem('activeRcId', 'all')
    }
  }

  const activeRc = revenueCenters.find(rc => rc.id === activeRcId) ?? null

  return (
    <RcContext.Provider value={{ revenueCenters, activeRcId, activeRc, setActiveRcId, reload: load }}>
      {children}
    </RcContext.Provider>
  )
}

export const useRc = () => useContext(RcContext)

```


---

## `src/contexts/DrawerContext.tsx`

```tsx
'use client'
import { createContext, useContext, useState, useCallback } from 'react'

interface DrawerContextValue {
  isAnyDrawerOpen: boolean
  setDrawerOpen: (open: boolean) => void
}

const DrawerContext = createContext<DrawerContextValue>({
  isAnyDrawerOpen: false,
  setDrawerOpen: () => {},
})

export function DrawerProvider({ children }: { children: React.ReactNode }) {
  const [count, setCount] = useState(0)
  const setDrawerOpen = useCallback((open: boolean) => {
    setCount(n => open ? n + 1 : Math.max(0, n - 1))
  }, [])
  return (
    <DrawerContext.Provider value={{ isAnyDrawerOpen: count > 0, setDrawerOpen }}>
      {children}
    </DrawerContext.Provider>
  )
}

export const useDrawer = () => useContext(DrawerContext)

```


---

## `src/contexts/NotificationContext.tsx`

```tsx
'use client'
import { createContext, useContext, useState, useCallback, useRef, ReactNode } from 'react'
import { useToast } from '@/components/Toast'

export interface SoftNotification {
  id: string
  type: 'invoice_ready' | 'invoice_applied'
  sessionId: string
  supplierName: string | null
  invoiceNumber: string | null
  actionLabel: string
  onAction: () => void
}

interface NotificationContextValue {
  notifications: SoftNotification[]
  push: (n: Omit<SoftNotification, 'id'>) => void
  dismiss: (id: string) => void
  dismissAll: () => void
}

const NotificationContext = createContext<NotificationContextValue>({
  notifications: [],
  push: () => {},
  dismiss: () => {},
  dismissAll: () => {},
})

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<SoftNotification[]>([])
  const counterRef = useRef(0)
  const toast = useToast()
  const toastShowRef = useRef(toast.show)
  toastShowRef.current = toast.show

  const push = useCallback((n: Omit<SoftNotification, 'id'>) => {
    counterRef.current++
    const id = `notif-${counterRef.current}`
    setNotifications(prev => {
      // Replace any existing notification for the same session
      const filtered = prev.filter(x => x.sessionId !== n.sessionId)
      return [...filtered, { ...n, id }]
    })

    // Fire toast side-effect
    const supplierLabel = n.supplierName ?? 'Unknown supplier'
    const invoiceSuffix = n.invoiceNumber ? ` · #${n.invoiceNumber}` : ''
    const message = supplierLabel + invoiceSuffix

    if (n.type === 'invoice_ready') {
      toastShowRef.current({ type: 'info', title: 'Invoice ready to review', message })
    } else if (n.type === 'invoice_applied') {
      toastShowRef.current({ type: 'success', title: 'Invoice applied', message })
    }
  }, [])

  const dismiss = useCallback((id: string) => {
    setNotifications(prev => prev.filter(x => x.id !== id))
  }, [])

  const dismissAll = useCallback(() => setNotifications([]), [])

  return (
    <NotificationContext.Provider value={{ notifications, push, dismiss, dismissAll }}>
      {children}
    </NotificationContext.Provider>
  )
}

export const useNotifications = () => useContext(NotificationContext)

```


---

## `src/components/Toast.tsx`

```tsx
'use client'
import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────────────────

type ToastType = 'success' | 'error' | 'warning' | 'info'

export interface ToastOptions {
  type?: ToastType
  title: string
  message?: string
  duration?: number
}

interface ToastContextValue {
  show: (opts: ToastOptions) => string
  dismiss: (id: string) => void
}

interface ToastItem {
  id: string
  type: ToastType
  title: string
  message?: string
  duration: number
  phase: 'entering' | 'visible' | 'exiting'
}

// ── Context ────────────────────────────────────────────────────────────────────

const ToastContext = createContext<ToastContextValue>({
  show: () => '',
  dismiss: () => {},
})

export const useToast = () => useContext(ToastContext)

// ── Accent colors ──────────────────────────────────────────────────────────────

const ACCENT: Record<ToastType, string> = {
  success: '#00ff88',
  error:   '#ff6b6b',
  warning: '#ffc700',
  info:    '#00c4ff',
}

// ── ToastItem (internal) ───────────────────────────────────────────────────────

function ToastItemComponent({
  toast,
  onDismiss,
}: {
  toast: ToastItem
  onDismiss: (id: string) => void
}) {
  const timerRef  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startRef  = useRef<number>(Date.now())
  const remaining = useRef<number>(toast.duration)
  const [paused, setPaused] = useState(false)

  const startTimer = useCallback(() => {
    startRef.current = Date.now()
    timerRef.current = setTimeout(() => onDismiss(toast.id), remaining.current)
  }, [toast.id, onDismiss])

  useEffect(() => {
    startTimer()
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [startTimer])

  const handleMouseEnter = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    remaining.current = Math.max(0, remaining.current - (Date.now() - startRef.current))
    setPaused(true)
  }

  const handleMouseLeave = () => {
    setPaused(false)
    startTimer()
  }

  const Icon =
    toast.type === 'success' ? CheckCircle2 :
    toast.type === 'error'   ? XCircle :
    toast.type === 'warning' ? AlertTriangle :
    Info

  const accent = ACCENT[toast.type]

  const phaseClass =
    toast.phase === 'visible'  ? 'toast-item--visible'  :
    toast.phase === 'exiting'  ? 'toast-item--exiting'  :
    'toast-item--entering'

  return (
    <div
      className={`toast-item ${phaseClass}`}
      style={{ '--accent': accent } as React.CSSProperties}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      role="alert"
    >
      {/* Left accent stripe */}
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: accent, borderRadius: '10px 0 0 10px' }} />

      {/* Icon */}
      <div style={{ flexShrink: 0, marginTop: 1, paddingLeft: 6 }}>
        <Icon size={16} color={accent} />
      </div>

      {/* Text */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="toast-title">{toast.title}</div>
        {toast.message && <div className="toast-message">{toast.message}</div>}
      </div>

      {/* Close */}
      <button
        className="toast-close"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
        style={{ flexShrink: 0 }}
      >
        <X size={12} />
      </button>

      {/* Progress bar */}
      <div className="toast-progress">
        <div
          className="toast-progress-fill"
          style={{
            '--duration': `${toast.duration}ms`,
            background: accent,
            animationPlayState: paused ? 'paused' : 'running',
          } as React.CSSProperties}
        />
      </div>
    </div>
  )
}

// ── ToastStack (internal) ──────────────────────────────────────────────────────

function ToastStack({
  toasts,
  dismiss,
}: {
  toasts: ToastItem[]
  dismiss: (id: string) => void
}) {
  return (
    <div
      role="log"
      aria-live="polite"
      aria-label="Notifications"
      style={{
        position: 'fixed',
        top: 16,
        right: 16,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        width: 'min(360px, calc(100vw - 32px))',
        pointerEvents: 'none',
      }}
    >
      {toasts.map(t => (
        <ToastItemComponent key={t.id} toast={t} onDismiss={dismiss} />
      ))}
    </div>
  )
}

// ── ToastProvider ──────────────────────────────────────────────────────────────

let _counter = 0

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [mounted, setMounted] = useState(false)

  useEffect(() => { setMounted(true) }, [])

  const dismiss = useCallback((id: string) => {
    // Flip to exiting
    setToasts(prev =>
      prev.map(t => t.id === id ? { ...t, phase: 'exiting' as const } : t)
    )
    // Remove after exit animation
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, 320)
  }, [])

  const show = useCallback((opts: ToastOptions): string => {
    _counter++
    const id = `toast-${_counter}`
    const item: ToastItem = {
      id,
      type: opts.type ?? 'info',
      title: opts.title,
      message: opts.message,
      duration: opts.duration ?? 5000,
      phase: 'entering',
    }

    setToasts(prev => {
      const next = [...prev, item]
      // Max 5 — trim oldest if over limit
      if (next.length > 5) {
        const trimmed = next.slice(next.length - 5)
        return trimmed
      }
      return next
    })

    // Double rAF to flip entering → visible after paint
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setToasts(prev =>
          prev.map(t => t.id === id ? { ...t, phase: 'visible' as const } : t)
        )
      })
    })

    return id
  }, [])

  return (
    <ToastContext.Provider value={{ show, dismiss }}>
      {children}
      {mounted && typeof window !== 'undefined' &&
        createPortal(<ToastStack toasts={toasts} dismiss={dismiss} />, document.body)
      }
    </ToastContext.Provider>
  )
}

```


---

## `src/components/GlobalSearch.tsx`

```tsx
'use client'
import { useEffect, useRef, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Search, Package, BookOpen, FileText, Truck, X, ArrowRight, UtensilsCrossed } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

interface SearchResult {
  id: string
  href: string
  icon: React.ReactNode
  title: string
  subtitle: string
  badge?: { label: string; color: string }
}

interface RawResults {
  inventory: Array<{ id: string; itemName: string; category: string; stockOnHand: number; baseUnit: string; pricePerBaseUnit: number }>
  recipes: Array<{ id: string; name: string; type: string; menuPrice: number | null; totalCost: number; category: { name: string } | null }>
  invoices: Array<{ id: string; invoiceNumber: string; status: string; invoiceDate: string; totalAmount: number; supplier: { name: string } }>
  suppliers: Array<{ id: string; name: string }>
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  COMPLETE: 'bg-green-100 text-green-700',
  PROCESSING: 'bg-gold/15 text-gold',
  PENDING: 'bg-amber-100 text-amber-700',
}

function buildResults(raw: RawResults): { group: string; items: SearchResult[] }[] {
  const groups: { group: string; items: SearchResult[] }[] = []

  if (raw.inventory.length > 0) {
    groups.push({
      group: 'Inventory',
      items: raw.inventory.map(i => ({
        id: i.id,
        href: `/inventory?search=${encodeURIComponent(i.itemName)}`,
        icon: <Package size={14} className="text-blue-500 shrink-0" />,
        title: i.itemName,
        subtitle: `${i.category} · ${parseFloat(String(i.stockOnHand)).toFixed(1)} ${i.baseUnit} on hand · ${formatCurrency(parseFloat(String(i.pricePerBaseUnit)))}/${i.baseUnit}`,
      })),
    })
  }

  if (raw.recipes.length > 0) {
    groups.push({
      group: 'Recipes',
      items: raw.recipes.map(r => {
        const isMenu = r.type === 'MENU'
        const cost = parseFloat(String(r.totalCost))
        const price = r.menuPrice ? parseFloat(String(r.menuPrice)) : null
        const pct = price ? (cost / price) * 100 : null
        return {
          id: r.id,
          href: isMenu ? `/menu` : `/recipes`,
          icon: isMenu
            ? <UtensilsCrossed size={14} className="text-purple-500 shrink-0" />
            : <BookOpen size={14} className="text-emerald-600 shrink-0" />,
          title: r.name,
          subtitle: `${r.category?.name ?? ''} · ${formatCurrency(cost)} total cost${pct !== null ? ` · ${pct.toFixed(1)}% food cost` : ''}`,
          badge: isMenu
            ? { label: 'Menu', color: 'bg-purple-50 text-purple-600' }
            : { label: 'Prep', color: 'bg-emerald-50 text-emerald-600' },
        }
      }),
    })
  }

  if (raw.invoices.length > 0) {
    groups.push({
      group: 'Invoices',
      items: raw.invoices.map(inv => ({
        id: inv.id,
        href: `/invoices`,
        icon: <FileText size={14} className="text-gray-500 shrink-0" />,
        title: inv.invoiceNumber || '(No number)',
        subtitle: `${inv.supplier.name} · ${new Date(inv.invoiceDate).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })} · ${formatCurrency(parseFloat(String(inv.totalAmount)))}`,
        badge: { label: inv.status, color: STATUS_COLORS[inv.status] ?? 'bg-gray-100 text-gray-500' },
      })),
    })
  }

  if (raw.suppliers.length > 0) {
    groups.push({
      group: 'Suppliers',
      items: raw.suppliers.map(s => ({
        id: s.id,
        href: `/suppliers/${s.id}`,
        icon: <Truck size={14} className="text-gray-400 shrink-0" />,
        title: s.name,
        subtitle: 'Supplier',
      })),
    })
  }

  return groups
}

// ─── Component ────────────────────────────────────────────────────────────────

export function GlobalSearch() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [groups, setGroups] = useState<{ group: string; items: SearchResult[] }[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedIdx, setSelectedIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Flatten all items for keyboard navigation
  const allItems = groups.flatMap(g => g.items)

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
    setGroups([])
    setSelectedIdx(0)
  }, [])

  const navigate = useCallback((href: string) => {
    close()
    router.push(href)
  }, [close, router])

  // Cmd+K / Ctrl+K listener
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setOpen(o => !o)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Focus input when opened
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50)
  }, [open])

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (query.length < 2) { setGroups([]); setLoading(false); return }
    setLoading(true)
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`)
        const raw: RawResults = await res.json()
        setGroups(buildResults(raw))
        setSelectedIdx(0)
      } finally {
        setLoading(false)
      }
    }, 220)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [query])

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { close(); return }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIdx(i => Math.min(i + 1, allItems.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIdx(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && allItems[selectedIdx]) {
      navigate(allItems[selectedIdx].href)
    }
  }

  if (!open) return null

  const isEmpty = query.length >= 2 && !loading && groups.length === 0

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[10vh] px-4"
      onMouseDown={e => { if (e.target === e.currentTarget) close() }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" />

      {/* Panel */}
      <div className="relative w-full max-w-xl bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[70vh]">

        {/* Input row */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100">
          <Search size={17} className="text-gray-400 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search inventory, recipes, invoices, suppliers…"
            className="flex-1 text-sm text-gray-900 placeholder-gray-400 outline-none bg-transparent"
          />
          {loading && (
            <div className="w-3.5 h-3.5 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin shrink-0" />
          )}
          {query && !loading && (
            <button onClick={() => { setQuery(''); setGroups([]); inputRef.current?.focus() }}
              className="text-gray-300 hover:text-gray-500 shrink-0">
              <X size={15} />
            </button>
          )}
          <kbd className="hidden sm:inline-flex items-center gap-0.5 text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded font-mono shrink-0">
            esc
          </kbd>
        </div>

        {/* Results */}
        <div className="overflow-y-auto flex-1">
          {query.length < 2 && (
            <div className="px-4 py-10 text-center text-sm text-gray-400">
              Type to search across inventory, recipes, invoices and suppliers
            </div>
          )}

          {isEmpty && (
            <div className="px-4 py-10 text-center text-sm text-gray-400">
              No results for <span className="font-medium text-gray-600">&ldquo;{query}&rdquo;</span>
            </div>
          )}

          {groups.map(({ group, items }) => {
            const groupStart = allItems.indexOf(items[0])
            return (
              <div key={group}>
                <div className="px-4 pt-3 pb-1 text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
                  {group}
                </div>
                {items.map((item, j) => {
                  const idx = groupStart + j
                  const active = idx === selectedIdx
                  return (
                    <button
                      key={item.id}
                      onMouseEnter={() => setSelectedIdx(idx)}
                      onClick={() => navigate(item.href)}
                      className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${active ? 'bg-gold/10' : 'hover:bg-gray-50'}`}
                    >
                      <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${active ? 'bg-gold/15' : 'bg-gray-100'}`}>
                        {item.icon}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-900 truncate flex items-center gap-2">
                          {item.title}
                          {item.badge && (
                            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 ${item.badge.color}`}>
                              {item.badge.label}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-gray-400 truncate mt-0.5">{item.subtitle}</div>
                      </div>
                      <ArrowRight size={13} className={`shrink-0 transition-opacity ${active ? 'text-blue-400 opacity-100' : 'opacity-0'}`} />
                    </button>
                  )
                })}
              </div>
            )
          })}

          {groups.length > 0 && (
            <div className="px-4 py-2 border-t border-gray-50 flex items-center gap-3 text-[10px] text-gray-300">
              <span><kbd className="font-mono bg-gray-100 px-1 rounded">↑↓</kbd> navigate</span>
              <span><kbd className="font-mono bg-gray-100 px-1 rounded">↵</kbd> open</span>
              <span><kbd className="font-mono bg-gray-100 px-1 rounded">esc</kbd> close</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

```


---

## `src/components/AlertsBell.tsx`

```tsx
'use client'
import { useEffect, useState, useRef } from 'react'
import { Bell, TrendingUp, TrendingDown, ChevronRight, X, Check, FileText, CheckCircle2 } from 'lucide-react'
import Link from 'next/link'
import { formatCurrency } from '@/lib/utils'
import { useNotifications } from '@/contexts/NotificationContext'

interface PriceAlert {
  id: string
  previousPrice: number
  newPrice: number
  changePct: number
  direction: string
  acknowledged: boolean
  inventoryItem: { id: string; itemName: string }
  session: { id: string; supplierName: string | null; invoiceDate: string | null }
}

interface RecipeAlert {
  id: string
  previousCost: number
  newCost: number
  changePct: number
  newFoodCostPct: number | null
  exceededThreshold: boolean
  acknowledged: boolean
  recipe: { id: string; name: string; menuPrice: number | null }
  session: { id: string; supplierName: string | null; invoiceDate: string | null }
}

interface AlertsBellProps {
  dropdownAlign?: 'left' | 'right'
}

export function AlertsBell({ dropdownAlign = 'left' }: AlertsBellProps) {
  const [open, setOpen] = useState(false)
  const [priceAlerts, setPriceAlerts] = useState<PriceAlert[]>([])
  const [recipeAlerts, setRecipeAlerts] = useState<RecipeAlert[]>([])
  const [totalUnread, setTotalUnread] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const { notifications, dismiss, dismissAll } = useNotifications()

  const fetchAlerts = async () => {
    try {
      const data = await fetch('/api/invoices/alerts').then(r => r.json())
      setPriceAlerts(data.priceAlerts || [])
      setRecipeAlerts(data.recipeAlerts || [])
      setTotalUnread(data.totalUnread || 0)
    } catch {}
  }

  useEffect(() => {
    fetchAlerts()
    const interval = setInterval(fetchAlerts, 30000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const acknowledgeAll = async () => {
    await fetch('/api/invoices/alerts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acknowledgeAll: true }),
    })
    fetchAlerts()
  }

  const badgeCount = totalUnread + notifications.length
  const dropdownPos = dropdownAlign === 'right' ? 'right-0' : 'left-0'

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="relative p-2 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
      >
        <Bell size={18} />
        {badgeCount > 0 && (
          <span className="absolute top-1 right-1 w-4 h-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center leading-none">
            {badgeCount > 9 ? '9+' : badgeCount}
          </span>
        )}
      </button>

      {open && (
        <div className={`absolute ${dropdownPos} top-full mt-2 w-[min(320px,calc(100vw-16px))] bg-white rounded-2xl shadow-xl border border-gray-100 z-50 overflow-hidden`}>
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-50">
            <span className="font-semibold text-gray-900 text-sm">Notifications</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => { acknowledgeAll(); dismissAll() }}
                disabled={badgeCount === 0}
                className={`text-xs flex items-center gap-1 ${badgeCount > 0 ? 'text-gold hover:underline' : 'text-gray-300 cursor-default'}`}
              >
                <Check size={10} /> Clear all
              </button>
              <button onClick={() => setOpen(false)}>
                <X size={14} className="text-gray-400" />
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="max-h-80 overflow-y-auto">
            {notifications.length === 0 && priceAlerts.length === 0 && recipeAlerts.length === 0 ? (
              <div className="text-center py-8 text-gray-400 text-sm">
                No notifications
              </div>
            ) : (
              <>
                {/* ── Soft notifications (invoice ready / applied) ──────────── */}
                {notifications.map(n => (
                  <div key={n.id} className="px-4 py-3 border-b border-gray-50 hover:bg-gray-50">
                    <div className="flex items-start gap-2">
                      <div className={`mt-0.5 p-1 rounded-full ${n.type === 'invoice_applied' ? 'bg-green-100' : 'bg-blue-100'}`}>
                        {n.type === 'invoice_applied'
                          ? <CheckCircle2 size={12} className="text-green-500" />
                          : <FileText size={12} className="text-blue-500" />
                        }
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-800">
                          {n.type === 'invoice_applied' ? 'Invoice applied' : 'Invoice ready to review'}
                        </p>
                        <p className="text-xs text-gray-500 truncate">
                          {n.supplierName ?? 'Unknown supplier'}
                          {n.invoiceNumber ? ` · #${n.invoiceNumber}` : ''}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => { n.onAction(); setOpen(false) }}
                          className="text-[10px] text-gold hover:underline font-medium"
                        >
                          {n.actionLabel}
                        </button>
                        <button onClick={() => dismiss(n.id)} className="ml-1 text-gray-300 hover:text-gray-500">
                          <X size={12} />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}

                {/* ── DB price alerts ───────────────────────────────────────── */}
                {priceAlerts.map(alert => (
                  <div key={alert.id} className="px-4 py-3 border-b border-gray-50 hover:bg-gray-50">
                    <div className="flex items-start gap-2">
                      <div className={`mt-0.5 p-1 rounded-full ${alert.direction === 'UP' ? 'bg-red-100' : 'bg-green-100'}`}>
                        {alert.direction === 'UP'
                          ? <TrendingUp size={12} className="text-red-500" />
                          : <TrendingDown size={12} className="text-green-500" />
                        }
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-800 truncate">{alert.inventoryItem.itemName}</p>
                        <p className="text-xs text-gray-500">
                          {formatCurrency(Number(alert.previousPrice))} → {formatCurrency(Number(alert.newPrice))}
                          {' '}<span className={`font-semibold ${alert.direction === 'UP' ? 'text-red-600' : 'text-green-600'}`}>
                            ({alert.direction === 'UP' ? '+' : ''}{Number(alert.changePct).toFixed(1)}%)
                          </span>
                        </p>
                        {alert.session.supplierName && (
                          <p className="text-[10px] text-gray-400">{alert.session.supplierName}</p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}

                {/* ── DB recipe alerts ──────────────────────────────────────── */}
                {recipeAlerts.map(alert => (
                  <div key={alert.id} className="px-4 py-3 border-b border-gray-50 hover:bg-gray-50">
                    <div className="flex items-start gap-2">
                      <div className={`mt-0.5 p-1 rounded-full ${alert.exceededThreshold ? 'bg-red-100' : 'bg-amber-100'}`}>
                        <TrendingUp size={12} className={alert.exceededThreshold ? 'text-red-500' : 'text-amber-500'} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-800 truncate">{alert.recipe.name}</p>
                        {alert.exceededThreshold && alert.newFoodCostPct !== null && (
                          <p className="text-xs text-red-600 font-semibold">
                            Food cost {(Number(alert.newFoodCostPct) * 100).toFixed(1)}% — exceeds 30% threshold
                          </p>
                        )}
                        <p className="text-xs text-gray-500">Recipe cost changed</p>
                      </div>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>

          {/* Footer */}
          <Link
            href="/invoices"
            onClick={() => setOpen(false)}
            className="flex items-center justify-center gap-1 px-4 py-2.5 text-xs text-gold hover:bg-gold/10 transition-colors border-t border-gray-50"
          >
            View all invoices <ChevronRight size={12} />
          </Link>
        </div>
      )}
    </div>
  )
}

```


---

## `src/components/AiChat.tsx`

```tsx
'use client'

import { useState, useRef, useEffect } from 'react'
import { MessageCircle, X, Sparkles, Send, History, Trash2, ChevronLeft, Plus } from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { useDrawer } from '@/contexts/DrawerContext'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

interface ConversationSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  _count: { messages: number }
}

// ── Lightweight markdown renderer (no extra dependencies) ─────────────────────
// Handles: **bold**, *italic*, `code`, - bullet lists, numbered lists, blank lines

function parseInline(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g)
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**'))
      return <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>
    if (part.startsWith('*') && part.endsWith('*'))
      return <em key={i}>{part.slice(1, -1)}</em>
    if (part.startsWith('`') && part.endsWith('`'))
      return <code key={i} className="bg-black/10 rounded px-1 text-[11px] font-mono">{part.slice(1, -1)}</code>
    return part
  })
}

function MarkdownContent({ content, isUser }: { content: string; isUser: boolean }) {
  const lines = content.split('\n')
  const nodes: React.ReactNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Bullet list item
    if (/^[-•*]\s+/.test(line)) {
      const items: React.ReactNode[] = []
      while (i < lines.length && /^[-•*]\s+/.test(lines[i])) {
        items.push(<li key={i}>{parseInline(lines[i].replace(/^[-•*]\s+/, ''))}</li>)
        i++
      }
      nodes.push(<ul key={`ul${i}`} className="list-disc pl-4 space-y-0.5 my-1">{items}</ul>)
      continue
    }

    // Numbered list item
    if (/^\d+\.\s+/.test(line)) {
      const items: React.ReactNode[] = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(<li key={i}>{parseInline(lines[i].replace(/^\d+\.\s+/, ''))}</li>)
        i++
      }
      nodes.push(<ol key={`ol${i}`} className="list-decimal pl-4 space-y-0.5 my-1">{items}</ol>)
      continue
    }

    // Blank line → small spacer
    if (line.trim() === '') {
      if (nodes.length > 0) nodes.push(<div key={`sp${i}`} className="h-1" />)
      i++; continue
    }

    // Normal paragraph line
    nodes.push(<p key={i} className="leading-relaxed">{parseInline(line)}</p>)
    i++
  }

  return (
    <div className={`space-y-0.5 text-sm ${isUser ? 'text-white' : 'text-gray-800'}`}>
      {nodes}
    </div>
  )
}

const QUICK_PROMPTS = [
  "What's out of stock?",
  'Any invoices to review?',
  'Show high food cost recipes',
  'How do I add a new invoice?',
]

function ThinkingDots() {
  return (
    <div className="flex items-center gap-1 px-3 py-2">
      <span className="w-2 h-2 rounded-full bg-gray-400 animate-bounce [animation-delay:-0.3s]" />
      <span className="w-2 h-2 rounded-full bg-gray-400 animate-bounce [animation-delay:-0.15s]" />
      <span className="w-2 h-2 rounded-full bg-gray-400 animate-bounce" />
    </div>
  )
}

export function AiChat() {
  const { activeRcId, activeRc } = useRc()
  const { isAnyDrawerOpen } = useDrawer()
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [view, setView] = useState<'chat' | 'history'>('chat')
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [loadingHistory, setLoadingHistory] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, open])

  useEffect(() => {
    if (open && view === 'chat') {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [open, view])

  const startNewConversation = () => {
    setMessages([])
    setConversationId(null)
    setView('chat')
    setInput('')
    setTimeout(() => inputRef.current?.focus(), 100)
  }

  const loadHistory = async () => {
    setView('history')
    setLoadingHistory(true)
    try {
      const res = await fetch('/api/chat/conversations')
      const data = await res.json()
      setConversations(data)
    } finally {
      setLoadingHistory(false)
    }
  }

  const loadConversation = async (id: string) => {
    const res = await fetch(`/api/chat/conversations/${id}`)
    const data = await res.json()
    setMessages(data.messages.map((m: { role: 'user' | 'assistant'; content: string }) => ({
      role: m.role,
      content: m.content,
    })))
    setConversationId(id)
    setView('chat')
  }

  const deleteConversation = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    await fetch(`/api/chat/conversations/${id}`, { method: 'DELETE' })
    setConversations(prev => prev.filter(c => c.id !== id))
    if (conversationId === id) startNewConversation()
  }

  const sendMessage = async (content: string) => {
    if (!content.trim() || loading) return
    const userMsg: Message = { role: 'user', content: content.trim() }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setInput('')
    setLoading(true)
    setMessages(prev => [...prev, { role: 'assistant', content: '' }])

    // Create conversation on first message
    let convId = conversationId
    if (!convId) {
      try {
        const res = await fetch('/api/chat/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: content.trim().slice(0, 80) }),
        })
        const conv = await res.json()
        convId = conv.id
        setConversationId(convId)
      } catch { /* non-fatal */ }
    }

    let assistantContent = ''
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newMessages,
          rcId: activeRcId,
          isDefault: activeRc?.isDefault ?? false,
        }),
      })
      if (!res.body) throw new Error('No body')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        assistantContent += chunk
        setMessages(prev => {
          const copy = [...prev]
          copy[copy.length - 1] = { ...copy[copy.length - 1], content: copy[copy.length - 1].content + chunk }
          return copy
        })
      }
    } catch {
      assistantContent = 'Sorry, something went wrong. Please try again.'
      setMessages(prev => {
        const copy = [...prev]
        copy[copy.length - 1] = { ...copy[copy.length - 1], content: assistantContent }
        return copy
      })
    } finally {
      setLoading(false)
    }

    // Save messages to DB
    if (convId && assistantContent) {
      fetch(`/api/chat/conversations/${convId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([
          { role: 'user', content: content.trim() },
          { role: 'assistant', content: assistantContent },
        ]),
      }).catch(() => {})
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(input)
    }
  }

  return (
    <div className={`fixed bottom-[calc(4rem+env(safe-area-inset-bottom,0px)+0.75rem)] right-4 sm:bottom-6 sm:right-6 z-[55] ${isAnyDrawerOpen ? 'hidden' : ''}`}>
      {/* Chat panel */}
      {open && (
        <div className="absolute bottom-16 right-0 w-[calc(100vw-32px)] sm:w-96 max-h-[70vh] sm:max-h-[600px] bg-white rounded-2xl shadow-2xl border border-gray-100 flex flex-col overflow-hidden">
          {/* Header */}
          <div className="shrink-0 bg-gradient-to-r from-blue-600 to-blue-700 px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              {/* New conversation button */}
              <button
                onClick={startNewConversation}
                title="New conversation"
                className="text-blue-200 hover:text-white transition-colors p-0.5 rounded"
              >
                <Plus size={16} />
              </button>
              <Sparkles className="text-white" size={16} />
              <div>
                <div className="text-white font-bold text-sm leading-tight">CONTROLA</div>
                <div className="text-blue-200 text-xs">Your restaurant assistant</div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {/* History toggle */}
              <button
                onClick={view === 'history' ? () => setView('chat') : loadHistory}
                title={view === 'history' ? 'Back to chat' : 'Conversation history'}
                className="text-blue-200 hover:text-white transition-colors p-1 rounded"
              >
                {view === 'history' ? <ChevronLeft size={18} /> : <History size={18} />}
              </button>
              <button
                onClick={() => setOpen(false)}
                className="text-white hover:text-blue-200 transition-colors p-1"
                aria-label="Close chat"
              >
                <X size={18} />
              </button>
            </div>
          </div>

          {view === 'history' ? (
            /* History view */
            <div className="flex-1 overflow-y-auto">
              {loadingHistory ? (
                <div className="flex items-center justify-center py-12">
                  <div className="flex gap-1">
                    <span className="w-2 h-2 rounded-full bg-gray-300 animate-bounce [animation-delay:-0.3s]" />
                    <span className="w-2 h-2 rounded-full bg-gray-300 animate-bounce [animation-delay:-0.15s]" />
                    <span className="w-2 h-2 rounded-full bg-gray-300 animate-bounce" />
                  </div>
                </div>
              ) : conversations.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
                  <History size={32} className="text-gray-300 mb-3" />
                  <p className="text-sm text-gray-500">No conversations yet</p>
                  <p className="text-xs text-gray-400 mt-1">Start chatting to build your history</p>
                </div>
              ) : (
                <div className="divide-y divide-gray-50">
                  {conversations.map(conv => (
                    <button
                      key={conv.id}
                      onClick={() => loadConversation(conv.id)}
                      className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors text-left group"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-800 truncate">{conv.title}</p>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {new Date(conv.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          {' · '}{conv._count.messages} messages
                        </p>
                      </div>
                      <button
                        onClick={(e) => deleteConversation(conv.id, e)}
                        className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-all shrink-0"
                        title="Delete conversation"
                      >
                        <Trash2 size={14} />
                      </button>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <>
              {/* Messages */}
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {messages.length === 0 ? (
                  <div className="space-y-3">
                    <div className="bg-gray-100 text-gray-800 rounded-2xl rounded-bl-sm px-3 py-2 text-sm mr-8 self-start">
                      Hi! I&apos;m CONTROLA, your restaurant back-office assistant. I can answer questions about your inventory, invoices, recipes, sales, and more. What would you like to know?
                    </div>
                    <div className="space-y-2 pt-1">
                      {QUICK_PROMPTS.map(prompt => (
                        <button
                          key={prompt}
                          onClick={() => sendMessage(prompt)}
                          className="w-full text-left text-sm px-3 py-2 rounded-xl border border-gray-200 hover:border-blue-300 hover:bg-gold/10 text-gray-700 transition-colors"
                        >
                          {prompt}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((msg, i) => (
                    <div
                      key={i}
                      className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                    >
                      {msg.role === 'assistant' && msg.content === '' && loading && i === messages.length - 1 ? (
                        <div className="bg-gray-100 rounded-2xl rounded-bl-sm mr-8">
                          <ThinkingDots />
                        </div>
                      ) : (
                        <div
                          className={
                            msg.role === 'user'
                              ? 'bg-gold rounded-2xl rounded-br-sm px-3 py-2 ml-8 max-w-[85%]'
                              : 'bg-gray-100 rounded-2xl rounded-bl-sm px-3 py-2 mr-8 max-w-[85%]'
                          }
                        >
                          <MarkdownContent content={msg.content} isUser={msg.role === 'user'} />
                        </div>
                      )}
                    </div>
                  ))
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Input area */}
              <div className="shrink-0 border-t border-gray-100 p-3">
                <div className="flex gap-2 items-center">
                  <input
                    ref={inputRef}
                    type="text"
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Ask anything..."
                    disabled={loading}
                    className="flex-1 min-w-0 text-sm px-3 py-2 rounded-xl border border-gray-200 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-gold disabled:opacity-50"
                  />
                  <button
                    onClick={() => sendMessage(input)}
                    disabled={loading || !input.trim()}
                    className="shrink-0 w-9 h-9 rounded-full bg-gold hover:bg-[#a88930] disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
                    aria-label="Send message"
                  >
                    <Send size={16} className="text-white" />
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* Toggle button */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-[52px] h-[52px] rounded-full shadow-lg flex items-center justify-center hover:shadow-xl transition-all"
        style={{ background: '#c9a84c' }}
        onMouseEnter={e => (e.currentTarget.style.background = '#a88930')}
        onMouseLeave={e => (e.currentTarget.style.background = '#c9a84c')}
        aria-label={open ? 'Close CONTROLA chat' : 'Open CONTROLA chat'}
      >
        {open ? (
          <X size={22} className="text-white" />
        ) : (
          <MessageCircle size={22} className="text-white" />
        )}
      </button>
    </div>
  )
}

```


---

## `src/components/CameraCapture.tsx`

```tsx
'use client'
/**
 * CameraCapture — full-screen camera overlay for invoice scanning.
 *
 * Features:
 *  • Live rear camera feed via getUserMedia (HTTPS / localhost)
 *  • Document frame guide: dark vignette + corner brackets + alignment tip
 *  • Real-time brightness indicator (updates every 600 ms)
 *  • Post-capture quality analysis: brightness, contrast, sharpness (Laplacian)
 *  • Quality feedback rendered inside bottom controls (never offscreen)
 *  • "Done" button in top bar once at least one page is captured
 *  • "Use Photo" / "Retake" flow per page; stays open so user can add more pages
 *  • Falls back gracefully when getUserMedia is unavailable (non-HTTPS LAN access)
 *    by using capture="environment" + the same post-capture quality analysis
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { X, RotateCcw, Check, AlertTriangle, Sun, Moon, Camera, CheckCircle2 } from 'lucide-react'

// ─── Quality analysis ─────────────────────────────────────────────────────────

interface Quality {
  brightness: number   // 0–255 luminance average
  sharpness: number    // Laplacian mean (higher = sharper)
  warnings: string[]
}

function analyzeFrame(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number
): Quality {
  if (!w || !h) return { brightness: 128, sharpness: 10, warnings: [] }
  const sw = Math.min(w, 320)
  const sh = Math.min(h, 240)
  const sx = Math.floor((w - sw) / 2)
  const sy = Math.floor((h - sh) / 2)
  const { data } = ctx.getImageData(sx, sy, sw, sh)

  let lumSum = 0
  let lumSqSum = 0
  const px = data.length / 4

  for (let i = 0; i < data.length; i += 4) {
    const l = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
    lumSum   += l
    lumSqSum += l * l
  }
  const brightness = lumSum / px
  const contrast   = Math.sqrt(lumSqSum / px - brightness * brightness)

  let lapSum = 0
  let lapCount = 0
  const cw = Math.floor(sw / 2)
  const ch = Math.floor(sh / 2)
  const cx0 = Math.floor(sw / 4)
  const cy0 = Math.floor(sh / 4)

  for (let y = cy0 + 1; y < cy0 + ch - 1; y += 3) {
    for (let x = cx0 + 1; x < cx0 + cw - 1; x += 3) {
      const i  = (y * sw + x) * 4
      const g  = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
      const iT = ((y - 1) * sw + x) * 4
      const iB = ((y + 1) * sw + x) * 4
      const iL = (y * sw + x - 1) * 4
      const iR = (y * sw + x + 1) * 4
      const gT = data[iT] * 0.299 + data[iT + 1] * 0.587 + data[iT + 2] * 0.114
      const gB = data[iB] * 0.299 + data[iB + 1] * 0.587 + data[iB + 2] * 0.114
      const gL = data[iL] * 0.299 + data[iL + 1] * 0.587 + data[iL + 2] * 0.114
      const gR = data[iR] * 0.299 + data[iR + 1] * 0.587 + data[iR + 2] * 0.114
      lapSum += Math.abs(4 * g - gT - gB - gL - gR)
      lapCount++
    }
  }
  const sharpness = lapCount > 0 ? lapSum / lapCount : 0

  const warnings: string[] = []
  if (brightness < 55)  warnings.push('Too dark — move to better lighting')
  if (brightness > 215) warnings.push('Too bright — avoid direct light on the page')
  if (contrast  < 15)   warnings.push('Low contrast — make sure the page is flat and fully lit')
  if (sharpness <  6)   warnings.push('May be blurry — hold the phone steady and wait for focus')

  return { brightness, sharpness, warnings }
}

// ─── Corner bracket SVG ───────────────────────────────────────────────────────

function Bracket({ color }: { color: string }) {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" stroke={color} strokeWidth="3.5" strokeLinecap="round">
      <path d="M2 18 L2 2 L18 2" />
    </svg>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

interface Props {
  onCapture:  (file: File) => void
  onClose:    () => void
  /** 1-based page number currently being captured — equals captured count + 1 */
  pageNumber: number
  maxPages:   number
}

export function CameraCapture({ onCapture, onClose, pageNumber, maxPages }: Props) {
  const videoRef    = useRef<HTMLVideoElement>(null)
  const canvasRef   = useRef<HTMLCanvasElement>(null)
  const fallbackRef = useRef<HTMLInputElement>(null)
  const streamRef   = useRef<MediaStream | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const [mode, setMode]           = useState<'loading' | 'live' | 'fallback'>('loading')
  const [liveReady, setLiveReady] = useState(false)
  const [lightLevel, setLightLevel] = useState<'dark' | 'ok' | 'bright'>('ok')
  const [preview,  setPreview]    = useState<string | null>(null)
  const [quality,  setQuality]    = useState<Quality | null>(null)

  // Number of photos captured so far in this session (pageNumber - 1)
  const capturedCount = pageNumber - 1

  // ── Start camera ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let active = true
    if (!navigator.mediaDevices?.getUserMedia) { setMode('fallback'); return }

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1440 } } })
      .then(stream => {
        if (!active) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream
        setMode('live')
      })
      .catch(() => { if (active) setMode('fallback') })

    return () => {
      active = false
      streamRef.current?.getTracks().forEach(t => t.stop())
    }
  }, [])

  // ── Attach stream once <video> is in the DOM ──────────────────────────────────
  useEffect(() => {
    if (mode !== 'live') return
    const v = videoRef.current
    if (!v || !streamRef.current) return
    v.srcObject = streamRef.current
    const onReady = () => { v.play().catch(() => {}); setLiveReady(true) }
    v.addEventListener('loadedmetadata', onReady)
    v.addEventListener('canplay', onReady)
    return () => { v.removeEventListener('loadedmetadata', onReady); v.removeEventListener('canplay', onReady) }
  }, [mode])

  // ── Live brightness monitor ────────────────────────────────────────────────
  useEffect(() => {
    if (mode !== 'live' || !liveReady || preview) return
    intervalRef.current = setInterval(() => {
      const v = videoRef.current; const c = canvasRef.current
      if (!v || !c || !v.videoWidth || !v.videoHeight) return
      const w = 80; const h = Math.round((v.videoHeight / v.videoWidth) * 80)
      if (!w || !h || !isFinite(h)) return
      c.width = w; c.height = h
      const ctx = c.getContext('2d'); if (!ctx) return
      ctx.drawImage(v, 0, 0, w, h)
      const { data } = ctx.getImageData(0, 0, w, h)
      let sum = 0
      for (let i = 0; i < data.length; i += 4) sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
      const avg = sum / (data.length / 4)
      setLightLevel(avg < 55 ? 'dark' : avg > 210 ? 'bright' : 'ok')
    }, 600)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [mode, liveReady, preview])

  // ── Capture from live feed ──────────────────────────────────────────────────
  const captureLive = useCallback(() => {
    const v = videoRef.current; const c = canvasRef.current
    if (!v || !c || !v.videoWidth || !v.videoHeight) return
    c.width = v.videoWidth; c.height = v.videoHeight
    const ctx = c.getContext('2d')!
    ctx.drawImage(v, 0, 0)
    const q = analyzeFrame(ctx, c.width, c.height)
    setQuality(q)
    setPreview(c.toDataURL('image/jpeg', 0.92))
  }, [])

  // ── Capture from native picker (fallback) ───────────────────────────────────
  const handleFallbackCapture = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return
    const url = URL.createObjectURL(file)
    const img = new window.Image()
    img.onload = () => {
      const c = canvasRef.current
      if (!c) { setPreview(url); setQuality({ brightness: 128, sharpness: 10, warnings: [] }); return }
      c.width = img.naturalWidth; c.height = img.naturalHeight
      const ctx = c.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      setQuality(analyzeFrame(ctx, c.width, c.height))
      setPreview(c.toDataURL('image/jpeg', 0.92))
      URL.revokeObjectURL(url)
    }
    img.src = url
    if (e.target) e.target.value = ''
  }, [])

  // ── Confirm / retake ────────────────────────────────────────────────────────
  const confirmPhoto = useCallback(() => {
    const c = canvasRef.current; if (!c) return
    const dataUrl = c.toDataURL('image/jpeg', 0.92)
    fetch(dataUrl).then(r => r.blob()).then(blob => {
      const file = new File([blob], `invoice-p${pageNumber}-${Date.now()}.jpg`, { type: 'image/jpeg' })
      onCapture(file)
      setPreview(null)
      setQuality(null)
    })
  }, [onCapture, pageNumber])

  const retake = useCallback(() => { setPreview(null); setQuality(null) }, [])

  const bracketColor = lightLevel === 'ok' ? '#4ade80' : '#ffffff'

  const frameStyle: React.CSSProperties = {
    position: 'absolute', top: '12%', left: '6%', right: '6%', bottom: '12%',
    boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
    borderRadius: 6, pointerEvents: 'none',
  }

  const hasWarnings = (quality?.warnings.length ?? 0) > 0

  // ══════════════════════════════════════════════════════════════════════════
  return (
    <div className="fixed inset-0 z-[70] bg-black flex flex-col">
      <canvas ref={canvasRef} className="hidden" />
      <input ref={fallbackRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handleFallbackCapture} />

      {/* ── TOP BAR ───────────────────────────────────────────────────────── */}
      <div
        className="absolute top-0 inset-x-0 z-20 flex items-center justify-between px-4 pb-6"
        style={{
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.80), transparent)',
          paddingTop: 'calc(2.5rem + env(safe-area-inset-top, 0px))',
        }}
      >
        {/* Close */}
        <button
          onClick={onClose}
          className="w-9 h-9 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center active:scale-90 transition-transform"
        >
          <X size={18} className="text-white" />
        </button>

        {/* Center label */}
        <div className="text-center">
          {capturedCount > 0 ? (
            <p className="text-white text-sm font-semibold">
              {capturedCount} page{capturedCount !== 1 ? 's' : ''} captured
            </p>
          ) : (
            <p className="text-white text-sm font-semibold">Scan Invoice</p>
          )}
          <p className="text-white/50 text-[11px]">
            Page {pageNumber}{maxPages > 1 ? ` of ${maxPages} max` : ''}
          </p>
        </div>

        {/* Done button — only when at least 1 photo captured and not reviewing a shot */}
        {capturedCount > 0 && !preview ? (
          <button
            onClick={onClose}
            className="px-3.5 py-1.5 rounded-full bg-white/20 backdrop-blur-sm text-white text-sm font-semibold active:scale-90 transition-transform"
          >
            Done
          </button>
        ) : (
          <div className="w-9" />
        )}
      </div>

      {/* ── MAIN AREA ──────────────────────────────────────────────────────── */}
      <div className="flex-1 relative overflow-hidden">

        {/* Video always in DOM — iOS pauses on display:none */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="absolute inset-0 w-full h-full object-cover"
          style={{ visibility: mode === 'live' ? 'visible' : 'hidden' }}
        />

        {/* ── LIVE overlays ── */}
        {mode === 'live' && !preview && liveReady && (
          <>
            {/* Vignette */}
            <div style={frameStyle} />

            {/* Corner brackets */}
            {[
              { top: 'calc(12% - 4px)',    left:  'calc(6% - 4px)',  transform: 'none' },
              { top: 'calc(12% - 4px)',    right: 'calc(6% - 4px)',  transform: 'rotate(90deg)' },
              { bottom: 'calc(12% - 4px)', right: 'calc(6% - 4px)',  transform: 'rotate(180deg)' },
              { bottom: 'calc(12% - 4px)', left:  'calc(6% - 4px)',  transform: 'rotate(270deg)' },
            ].map((style, i) => (
              <div key={i} className="absolute z-10 pointer-events-none" style={style}>
                <Bracket color={bracketColor} />
              </div>
            ))}

            {/* Alignment hint */}
            <div className="absolute inset-x-0 flex justify-center z-10 pointer-events-none" style={{ top: '13%' }}>
              <div className="bg-black/50 backdrop-blur-sm rounded-full px-3 py-1">
                <span className="text-white/90 text-[11px]">Fit the full invoice inside the frame</span>
              </div>
            </div>

            {/* Light level warning */}
            {lightLevel !== 'ok' && (
              <div className="absolute inset-x-0 flex justify-center z-10 pointer-events-none" style={{ bottom: '22%' }}>
                <div className={`flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-semibold backdrop-blur-sm shadow-lg ${
                  lightLevel === 'dark' ? 'bg-amber-500 text-white' : 'bg-orange-400 text-white'
                }`}>
                  {lightLevel === 'dark'
                    ? <><Moon size={13} /> Move to better lighting</>
                    : <><Sun  size={13} /> Avoid direct light on the page</>
                  }
                </div>
              </div>
            )}
          </>
        )}

        {/* ── FALLBACK tips ── */}
        {mode === 'fallback' && !preview && (
          <div className="absolute inset-0 flex flex-col items-center justify-center px-8 gap-6 bg-gray-900">
            <div className="relative w-44 aspect-[3/4] border-2 border-white/20 rounded-xl flex items-center justify-center">
              {[
                { top: -3, left: -3, transform: 'none' },
                { top: -3, right: -3, transform: 'rotate(90deg)' },
                { bottom: -3, right: -3, transform: 'rotate(180deg)' },
                { bottom: -3, left: -3, transform: 'rotate(270deg)' },
              ].map((s, i) => (
                <div key={i} className="absolute" style={s}><Bracket color="#4ade80" /></div>
              ))}
              <div className="text-center px-3 space-y-1.5">
                <p className="text-white/50 text-[11px] leading-relaxed">
                  Lay the invoice flat<br />Fill the frame<br />Avoid shadows
                </p>
              </div>
            </div>
            <div className="text-center space-y-1.5">
              <p className="text-white text-sm font-semibold">Position the invoice, then tap the shutter</p>
              <p className="text-white/50 text-xs leading-relaxed">
                Your camera will open — align the invoice before shooting
              </p>
            </div>
          </div>
        )}

        {/* ── Loading ── */}
        {mode === 'loading' && !preview && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-10 h-10 rounded-full border-2 border-white/30 border-t-white animate-spin" />
          </div>
        )}

        {/* ── Preview image ── */}
        {preview && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={preview}
            alt="Captured invoice"
            className="absolute inset-0 w-full h-full object-contain bg-black"
          />
        )}
      </div>

      {/* ── BOTTOM CONTROLS ────────────────────────────────────────────────── */}
      <div
        className="absolute bottom-0 inset-x-0 z-20"
        style={{
          background: 'linear-gradient(to top, rgba(0,0,0,0.90) 65%, transparent)',
          paddingBottom: 'max(1.75rem, env(safe-area-inset-bottom, 1rem))',
        }}
      >
        {!preview ? (
          /* ── Shutter ── */
          <div className="flex flex-col items-center pt-8 pb-2 gap-3">
            <button
              onClick={mode === 'live' ? captureLive : () => fallbackRef.current?.click()}
              disabled={mode === 'loading'}
              className="w-20 h-20 rounded-full bg-white shadow-2xl flex items-center justify-center active:scale-95 transition-transform disabled:opacity-40"
            >
              <div className="w-[68px] h-[68px] rounded-full border-[3px] border-gray-300 bg-white" />
            </button>
            <p className="text-white/60 text-xs">
              {mode === 'live'
                ? capturedCount > 0
                  ? `Tap to capture page ${pageNumber}`
                  : 'Tap when the invoice fills the frame'
                : 'Tap the shutter · your camera will open'}
            </p>
          </div>
        ) : (
          /* ── Quality feedback + Confirm / Retake ── */
          <div className="pt-5 pb-2">
            {/* Quality feedback — always inside controls, never offscreen */}
            {quality && (
              <div className="px-5 mb-3 space-y-2">
                {quality.warnings.length === 0 ? (
                  <div className="flex items-center gap-2.5 bg-green-500 rounded-2xl px-4 py-3">
                    <CheckCircle2 size={16} className="text-white shrink-0" />
                    <span className="text-white text-sm font-semibold">Looks great — ready to add</span>
                  </div>
                ) : (
                  quality.warnings.map((w, i) => (
                    <div key={i} className="flex items-center gap-2.5 bg-amber-500 rounded-2xl px-4 py-3">
                      <AlertTriangle size={15} className="text-white shrink-0" />
                      <span className="text-white text-sm font-medium">{w}</span>
                    </div>
                  ))
                )}
              </div>
            )}

            {/* Action buttons */}
            <div className="flex items-center gap-3 px-5">
              <button
                onClick={retake}
                className="flex-1 flex items-center justify-center gap-2 py-3.5 rounded-2xl border border-white/30 text-white text-sm font-semibold active:scale-95 transition-transform"
              >
                <RotateCcw size={15} /> Retake
              </button>
              <button
                onClick={confirmPhoto}
                className={`flex-[2] flex items-center justify-center gap-2 py-3.5 rounded-2xl text-white text-sm font-semibold active:scale-95 transition-transform ${
                  hasWarnings ? 'bg-amber-500' : 'bg-green-500'
                }`}
              >
                <Check size={15} />
                {hasWarnings ? 'Use Anyway' : 'Use Photo'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

```


---

## `src/components/StockStatus.tsx`

```tsx
'use client'

export function StockStatus({ stock, parLevel }: { stock: number; parLevel?: number | null }) {
  if (stock <= 0) return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
      Out of Stock
    </span>
  )
  if (parLevel != null && stock < parLevel) return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
      Low Stock
    </span>
  )
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
      In Stock
    </span>
  )
}

```


---

## `src/components/CategoryBadge.tsx`

```tsx
'use client'
import { CATEGORY_COLORS } from '@/lib/utils'

export function CategoryBadge({ category }: { category: string }) {
  const colors = CATEGORY_COLORS[category] || 'bg-gray-100 text-gray-800'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${colors}`}>
      {category}
    </span>
  )
}

```


---

## `src/components/AllergenBadges.tsx`

```tsx
'use client'
import { useState } from 'react'
import { X } from 'lucide-react'
import { ALLERGENS, ALLERGEN_MAP } from '@/lib/allergens'

interface BadgeProps {
  allergens: string[]
  size?: 'xs' | 'sm'
}

export function AllergenBadges({ allergens, size = 'xs' }: BadgeProps) {
  if (!allergens || allergens.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1">
      {allergens.map(key => {
        const def = ALLERGEN_MAP[key]
        if (!def) return null
        return (
          <span
            key={key}
            title={def.label}
            style={{ backgroundColor: def.hex, color: def.dark ? '#fff' : '#111' }}
            className={`inline-flex items-center rounded font-bold leading-none ${
              size === 'xs'
                ? 'px-1 py-0.5 text-[9px] tracking-wide'
                : 'px-1.5 py-1 text-[11px] tracking-wide'
            }`}
          >
            {def.abbr}
          </span>
        )
      })}
    </div>
  )
}

// Reusable toggle-tile grid — colored border when active, neutral when not
interface AllergenTogglesProps {
  active: Set<string>
  onToggle: (key: string) => void
}

export function AllergenToggles({ active, onToggle }: AllergenTogglesProps) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {ALLERGENS.map(a => {
        const on = active.has(a.key)
        return (
          <button
            key={a.key}
            type="button"
            onClick={() => onToggle(a.key)}
            style={on ? { borderColor: a.hex, backgroundColor: `${a.hex}18`, color: a.hex } : undefined}
            className={`flex flex-col items-center gap-0.5 py-2 px-1 rounded-xl border-2 transition-all select-none ${
              on ? 'shadow-sm' : 'border-gray-200 hover:border-gray-300 bg-white text-gray-400'
            }`}
          >
            <span className="text-[10px] font-bold tracking-wide">{a.abbr}</span>
            <span className="text-[9px] leading-tight text-center opacity-75">{a.label}</span>
          </button>
        )
      })}
    </div>
  )
}

interface BulkAllergenModalProps {
  count: number
  initialAllergens?: string[]
  onClose: () => void
  onApply: (allergens: string[], mode: 'add' | 'replace') => void
}

export function BulkAllergenModal({ count, initialAllergens = [], onClose, onApply }: BulkAllergenModalProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set(initialAllergens))

  const toggle = (key: string) =>
    setSelected(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-gray-900">Assign Allergens</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={16} /></button>
        </div>

        <div className="mb-5">
          <AllergenToggles active={selected} onToggle={toggle} />
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => onApply(Array.from(selected), 'replace')}
            className="flex-1 py-2 bg-gray-900 text-white text-sm font-medium rounded-lg hover:bg-gray-800"
          >
            Apply to {count} item{count !== 1 ? 's' : ''}
          </button>
          <button onClick={onClose} className="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

```


---

## `src/lib/rc-colors.ts`

```ts
export const RC_COLOR_MAP: Record<string, string> = {
  blue:   '#3B82F6',
  amber:  '#F59E0B',
  purple: '#8B5CF6',
  green:  '#22C55E',
  rose:   '#F43F5E',
  teal:   '#14B8A6',
  orange: '#F97316',
  indigo: '#6366F1',
}

export const RC_COLORS = Object.keys(RC_COLOR_MAP) as string[]

export function rcHex(color: string): string {
  return RC_COLOR_MAP[color] ?? '#6B7280'
}

```
