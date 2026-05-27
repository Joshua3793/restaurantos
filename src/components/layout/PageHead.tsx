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
