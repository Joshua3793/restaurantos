'use client'
import { useState } from 'react'
import { Mail, CheckCircle, AlertCircle, Send } from 'lucide-react'

export default function SettingsPage() {
  const [email, setEmail] = useState('kitchen@fergiescafe.ca')
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  const sendDigest = async () => {
    if (!email) return
    setSending(true)
    setResult(null)
    try {
      const res = await fetch('/api/digest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const data = await res.json()
      if (res.ok) {
        setResult({ ok: true, message: `Digest sent to ${email}` })
      } else {
        const msg = typeof data.error === 'string'
          ? data.error
          : data.error?.message ?? JSON.stringify(data.error) ?? 'Failed to send digest'
        setResult({ ok: false, message: msg })
      }
    } catch {
      setResult({ ok: false, message: 'Network error' })
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Page header — only shown on desktop (mobile sees the index list) */}
      <div className="hidden md:block border-b border-gray-100 pb-4">
        <h2 className="text-lg font-semibold text-gray-900">General</h2>
        <p className="text-sm text-gray-500 mt-0.5">Notifications and system configuration</p>
      </div>

      {/* Weekly Email Digest */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        {/* Section header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-50">
          <div className="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center shrink-0">
            <Mail size={16} className="text-blue-600" />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-900">Weekly Email Digest</p>
            <p className="text-xs text-gray-400">Automated summary of key restaurant metrics</p>
          </div>
        </div>

        {/* Settings rows */}
        <div className="divide-y divide-gray-50">
          {/* Email field */}
          <div className="px-5 py-4">
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
              Recipient Email
            </label>
            <div className="flex gap-2">
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="manager@fergies.kitchen"
                className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                onClick={sendDigest}
                disabled={sending || !email}
                className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap transition-colors"
              >
                <Send size={13} />
                {sending ? 'Sending…' : 'Send Test'}
              </button>
            </div>
            {result && (
              <div className={`flex items-center gap-2 mt-2 p-2.5 rounded-lg text-xs ${result.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                {result.ok ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
                {result.message}
              </div>
            )}
          </div>

          {/* What's included */}
          <div className="px-5 py-4">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Digest Includes</p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {[
                'Revenue this week vs last week',
                'Inventory stock value',
                'Wastage cost for the week',
                'Out of stock items',
                'Recipes with food cost >35%',
                'Price changes from invoices',
              ].map(item => (
                <div key={item} className="flex items-center gap-1.5 text-xs text-gray-500">
                  <div className="w-1 h-1 rounded-full bg-gray-300 shrink-0" />
                  {item}
                </div>
              ))}
            </div>
          </div>

          {/* Setup note */}
          <div className="px-5 py-4 bg-amber-50">
            <p className="text-xs text-amber-700">
              <span className="font-semibold">Setup required:</span> Add{' '}
              <code className="bg-amber-100 px-1 rounded font-mono">RESEND_API_KEY</code> to your{' '}
              <code className="bg-amber-100 px-1 rounded font-mono">.env</code> file —{' '}
              <a href="https://resend.com" target="_blank" rel="noopener noreferrer" className="underline font-medium">resend.com</a>
              . Also set <code className="bg-amber-100 px-1 rounded font-mono">NEXT_PUBLIC_APP_URL</code>.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
