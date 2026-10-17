interface HeroKPIProps {
  label: string
  value: string | number
  unit?: string
  context?: string
  className?: string
}

// Controla `.kpi.hero`: ink card, r-lg, 48px value, unit in gold at 22px.
export function HeroKPI({ label, value, unit = '%', context, className = '' }: HeroKPIProps) {
  return (
    <div className={`bg-ink text-paper rounded-lg px-5 py-[18px] ${className}`}>
      <p className="ui-label text-ink-4">{label}</p>
      <p className="text-[48px] font-semibold leading-none tracking-[-0.045em] whitespace-nowrap mt-2">
        {value}<span className="text-[22px] font-medium tracking-[-0.02em] text-gold">{unit}</span>
      </p>
      {context && (
        <p className="ui-meta text-ink-4 mt-2">{context}</p>
      )}
    </div>
  )
}
