interface KPIProps {
  label: string
  value: string | number
  sub?: string
  tone?: 'default' | 'alert' | 'ok'
  className?: string
}

// Controla `.kpi`: white card, r-lg, 18×20 padding, 34px value.
export function KPI({ label, value, sub, tone = 'default', className = '' }: KPIProps) {
  const valueColor =
    tone === 'alert' ? 'text-red' :
    tone === 'ok'    ? 'text-green' :
    'text-ink'

  return (
    <div className={`border border-line bg-paper rounded-lg px-5 py-[18px] ${className}`}>
      <p className="ui-label">{label}</p>
      <p className={`text-[34px] font-semibold leading-none tracking-[-0.04em] whitespace-nowrap mt-2 ${valueColor}`}>
        {value}
      </p>
      {sub && <p className="ui-meta mt-2">{sub}</p>}
    </div>
  )
}
