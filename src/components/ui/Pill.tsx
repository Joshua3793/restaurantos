import { ReactNode } from 'react'

interface PillProps {
  tone?: 'gold' | 'alert' | 'ok' | 'info' | 'default'
  children: ReactNode
  className?: string
}

// Controla `.pill`: ok / bad (alert) / warn (gold) / info / neutral (default).
const TONE_STYLES = {
  gold:    'bg-gold-soft text-gold-2',
  alert:   'bg-red-soft text-red-text',
  ok:      'bg-green-soft text-green-text',
  info:    'bg-blue-soft text-blue-text',
  default: 'bg-bg-2 text-ink-2',
}

export function Pill({ tone = 'default', children, className = '' }: PillProps) {
  return (
    <span className={`inline-flex items-center gap-[5px] whitespace-nowrap font-mono text-[10px] font-medium uppercase tracking-[0] px-[9px] py-[3px] rounded-full ${TONE_STYLES[tone]} ${className}`}>
      {children}
    </span>
  )
}
