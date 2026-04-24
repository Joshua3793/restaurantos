'use client'
import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { ChefHat } from 'lucide-react'
import { Suspense } from 'react'

function LoginPageInner() {
  const [mode, setMode] = useState<'login' | 'forgot'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const searchParams = useSearchParams()
  const urlError = searchParams.get('error')

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      router.push('/')
      router.refresh()
    }
  }

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    const supabase = createClient()
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/auth/set-password`,
    })
    setLoading(false)
    if (error) {
      setError(error.message)
    } else {
      setMessage('Check your email for a password reset link.')
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 w-full max-w-sm">
        <div className="flex items-center gap-2 mb-8">
          <div className="w-9 h-9 bg-blue-600 rounded-xl flex items-center justify-center">
            <ChefHat size={18} className="text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-gray-900 leading-tight">CONTROLA OS</h1>
            <p className="text-xs text-gray-400">Restaurant back-office</p>
          </div>
        </div>

        {mode === 'login' ? (
          <form onSubmit={handleLogin} className="space-y-4">
            {urlError === 'invalid_link' && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700">
                This link has expired or is invalid. Please request a new invite.
              </div>
            )}
            {urlError === 'deactivated' && (
              <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700">
                Your account has been deactivated. Please contact your admin.
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Signing in\u2026' : 'Sign in'}
            </button>
            <button
              type="button"
              onClick={() => { setMode('forgot'); setError('') }}
              className="w-full text-xs text-gray-400 hover:text-gray-600 text-center pt-1"
            >
              Forgot password?
            </button>
          </form>
        ) : (
          <form onSubmit={handleForgot} className="space-y-4">
            <p className="text-sm text-gray-600">
              Enter your email and we&apos;ll send a password reset link.
            </p>
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            {message && <p className="text-sm text-green-600">{message}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Sending\u2026' : 'Send reset link'}
            </button>
            <button
              type="button"
              onClick={() => { setMode('login'); setError(''); setMessage('') }}
              className="w-full text-xs text-gray-400 hover:text-gray-600 text-center pt-1"
            >
              Back to sign in
            </button>
          </form>
        )}

        <p className="text-xs text-center text-gray-400 mt-6">
          Don&apos;t have an account? Ask your admin for an invite.
        </p>
      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginPageInner />
    </Suspense>
  )
}
