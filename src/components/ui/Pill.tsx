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
