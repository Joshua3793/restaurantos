import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

function formatCurrency(n: number | null | undefined) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(n)
}

function formatPct(n: number | null | undefined) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return `${n.toFixed(1)}%`
}

function formatNumber(n: number | null | undefined) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return new Intl.NumberFormat('en-CA').format(n)
}

interface EodEmailBody {
  rcName?: string
  date?: string
  netSales?: number
  covers?: number
  foodCostDollars?: number
  foodCostPct?: number | null
  checklistDone?: number
  checklistTotal?: number
  closed?: boolean
  handoverNote?: string | null
  email?: string
}

export async function POST(req: NextRequest) {
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body: EodEmailBody = await req.json().catch(() => ({}))
  const toEmail: string = body.email ?? process.env.DIGEST_EMAIL ?? ''

  if (!toEmail) {
    return NextResponse.json({ error: 'No recipient email. Pass { email } or set DIGEST_EMAIL env var.' }, { status: 400 })
  }
  if (!process.env.RESEND_API_KEY) {
    return NextResponse.json({ error: 'Email not configured' }, { status: 400 })
  }
  const resend = new Resend(process.env.RESEND_API_KEY)

  const {
    rcName,
    date,
    netSales,
    covers,
    foodCostDollars,
    foodCostPct,
    checklistDone,
    checklistTotal,
    closed,
    handoverNote,
  } = body

  const checklistLabel =
    checklistDone !== undefined && checklistTotal !== undefined
      ? `${checklistDone} / ${checklistTotal} complete`
      : '—'

  const statusLabel = closed ? 'Closed' : 'Open'
  const statusColor = closed ? '#16a34a' : '#d97706'

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">

  <!-- Header -->
  <div style="background:#1e3a5f;border-radius:16px;padding:28px 32px;margin-bottom:20px">
    <div style="font-size:11px;color:#93c5fd;font-weight:600;letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px">End-of-Day Report</div>
    <div style="font-size:22px;font-weight:700;color:#fff">${rcName ?? 'Service'}</div>
    <div style="font-size:13px;color:#93c5fd;margin-top:4px">${date ?? ''}</div>
  </div>

  <!-- Status -->
  <div style="background:#fff;border-radius:12px;padding:16px 20px;border:1px solid #e5e7eb;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center">
    <span style="font-size:13px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Status</span>
    <span style="font-size:14px;font-weight:700;color:${statusColor}">${statusLabel}</span>
  </div>

  <!-- KPI grid -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px">
    <div style="background:#fff;border-radius:12px;padding:16px;border:1px solid #e5e7eb">
      <div style="font-size:10px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Net Sales</div>
      <div style="font-size:20px;font-weight:700;color:#111827;margin-top:4px">${formatCurrency(netSales)}</div>
    </div>
    <div style="background:#fff;border-radius:12px;padding:16px;border:1px solid #e5e7eb">
      <div style="font-size:10px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Covers</div>
      <div style="font-size:20px;font-weight:700;color:#111827;margin-top:4px">${formatNumber(covers)}</div>
    </div>
    <div style="background:#fff;border-radius:12px;padding:16px;border:1px solid #e5e7eb">
      <div style="font-size:10px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Food Cost $</div>
      <div style="font-size:20px;font-weight:700;color:#111827;margin-top:4px">${formatCurrency(foodCostDollars)}</div>
    </div>
    <div style="background:#fff;border-radius:12px;padding:16px;border:1px solid #e5e7eb">
      <div style="font-size:10px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Food Cost %</div>
      <div style="font-size:20px;font-weight:700;color:#111827;margin-top:4px">${formatPct(foodCostPct)}</div>
    </div>
  </div>

  <!-- Checklist -->
  <div style="background:#fff;border-radius:12px;padding:20px;border:1px solid #e5e7eb;margin-bottom:16px">
    <div style="font-size:13px;font-weight:700;color:#111827;margin-bottom:8px">Checklist</div>
    <div style="font-size:14px;color:#374151">${checklistLabel}</div>
  </div>

  ${handoverNote ? `
  <!-- Handover note -->
  <div style="background:#fff;border-radius:12px;padding:20px;border:1px solid #e5e7eb;margin-bottom:16px">
    <div style="font-size:13px;font-weight:700;color:#111827;margin-bottom:8px">Handover Note</div>
    <div style="font-size:14px;color:#374151;white-space:pre-wrap">${handoverNote}</div>
  </div>` : ''}

  <!-- Footer -->
  <div style="text-align:center;padding:16px 0;font-size:11px;color:#9ca3af">
    Sent by CONTROLA OS<br>
    <a href="${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}" style="color:#3b82f6">Open Dashboard</a>
  </div>

</div>
</body>
</html>`

  const { data, error } = await resend.emails.send({
    from: process.env.DIGEST_FROM ?? 'CONTROLA OS <onboarding@resend.dev>',
    to: toEmail,
    subject: `End-of-day — ${rcName ?? 'Service'} · ${date ?? ''}`,
    html,
  })

  if (error) return NextResponse.json({ error: error.message ?? JSON.stringify(error) }, { status: 500 })
  return NextResponse.json({ success: true, id: data?.id })
}
