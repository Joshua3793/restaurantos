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
      <p className="ui-label text-ink-4">{label}</p>
      <p className="text-[60px] font-semibold leading-none tracking-[-0.04em] mt-1">
        {value}<span className="text-gold">{unit}</span>
      </p>
      {context && (
        <p className="ui-meta text-ink-4 mt-2">{context}</p>
      )}
    </div>
  )
}
