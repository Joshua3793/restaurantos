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
      <h1 className="text-2xl font-bold text-gray-900">Settings</h1>

      {/* Weekly Email Digest */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-9 h-9 bg-blue-100 rounded-xl flex items-center justify-center shrink-0">
            <Mail size={18} className="text-blue-600" />
          </div>
          <div>
            <h2 className="font-semibold text-gray-900">Weekly Email Digest</h2>
            <p className="text-xs text-gray-500">Food cost %, revenue vs last week, price changes, out of stock, high food cost recipes</p>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Send to email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="manager@fergies.kitchen"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-700">
            <strong>Setup required:</strong> Add <code className="bg-amber-100 px-1 rounded">RESEND_API_KEY</code> to your <code className="bg-amber-100 px-1 rounded">.env</code> file. Get a free key at{' '}
            <a href="https://resend.com" target="_blank" rel="noopener noreferrer" className="underline font-medium">resend.com</a>.
            Also add <code className="bg-amber-100 px-1 rounded">NEXT_PUBLIC_APP_URL</code> (your deployed URL).
          </div>

          <button
            onClick={sendDigest}
            disabled={sending || !email}
            className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send size={14} />
            {sending ? 'Sending…' : 'Send Test Digest Now'}
          </button>

          {result && (
            <div className={`flex items-center gap-2 p-3 rounded-lg text-sm ${result.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
              {result.ok ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
              {result.message}
            </div>
          )}
        </div>

        <div className="mt-4 pt-4 border-t border-gray-100">
          <div className="text-xs font-medium text-gray-600 mb-2">Digest includes:</div>
          <ul className="space-y-1 text-xs text-gray-500">
            <li>• Revenue this week vs last week</li>
            <li>• Inventory value</li>
            <li>• Wastage cost for the week</li>
            <li>• Out of stock items</li>
            <li>• Recipes with food cost &gt;35%</li>
            <li>• Price changes from invoices</li>
          </ul>
        </div>
      </div>
    </div>
  )
}
