interface KPIProps {
  label: string
  value: string | number
  sub?: string
  tone?: 'default' | 'alert' | 'ok'
  className?: string
}

export function KPI({ label, value, sub, tone = 'default', className = '' }: KPIProps) {
  const valueColor =
    tone === 'alert' ? 'text-red' :
    tone === 'ok'    ? 'text-green' :
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
