'use client'
import { useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Image from 'next/image'
import { createClient } from '@/lib/supabase/client'

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
      window.location.href = '/'
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
    <div className="min-h-screen flex items-center justify-center p-4"
      style={{ background: '#0a0a0a' }}>

      {/* Subtle radial glow behind card */}
      <div className="absolute inset-0 pointer-events-none"
        style={{ background: 'radial-gradient(ellipse 60% 50% at 50% 40%, rgba(201,168,76,0.07) 0%, transparent 70%)' }} />

      <div className="relative w-full max-w-sm">
        {/* Logo mark */}
        <div className="flex flex-col items-center mb-8">
          <Image src="/logo-icon.png" alt="Controla OS" width={56} height={56}
            className="rounded-2xl mb-4" />
          <h1 className="text-xl font-bold tracking-wide" style={{ color: '#c9a84c' }}>
            Controla OS
          </h1>
          <p className="text-xs mt-1" style={{ color: 'rgba(255,255,255,0.3)' }}>
            Fergie&apos;s Kitchen
          </p>
        </div>

        {/* Card */}
        <div className="rounded-2xl p-7"
          style={{ background: '#161616', border: '1px solid rgba(255,255,255,0.08)' }}>

          {mode === 'login' ? (
            <form onSubmit={handleLogin} className="space-y-4">
              {urlError === 'invalid_link' && (
                <div className="rounded-lg px-3 py-2 text-xs"
                  style={{ background: 'rgba(217,119,6,0.12)', border: '1px solid rgba(217,119,6,0.25)', color: '#fbbf24' }}>
                  This link has expired or is invalid. Please request a new invite.
                </div>
              )}
              {urlError === 'deactivated' && (
                <div className="rounded-lg px-3 py-2 text-xs"
                  style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.25)', color: '#f87171' }}>
                  Your account has been deactivated. Please contact your admin.
                </div>
              )}
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-widest mb-1.5"
                  style={{ color: 'rgba(255,255,255,0.35)' }}>
                  Email
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  className="w-full px-3 py-2.5 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold transition-colors"
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-widest mb-1.5"
                  style={{ color: 'rgba(255,255,255,0.35)' }}>
                  Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  className="w-full px-3 py-2.5 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold transition-colors"
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                />
              </div>
              {error && <p className="text-xs" style={{ color: '#f87171' }}>{error}</p>}
              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50 transition-all mt-2"
                style={{ background: '#c9a84c', color: '#0a0a0a' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#a88930')}
                onMouseLeave={e => (e.currentTarget.style.background = '#c9a84c')}
              >
                {loading ? 'Signing in…' : 'Sign in'}
              </button>
              <button
                type="button"
                onClick={() => { setMode('forgot'); setError('') }}
                className="w-full text-xs text-center pt-1 transition-colors"
                style={{ color: 'rgba(255,255,255,0.3)' }}
                onMouseEnter={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.6)')}
                onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.3)')}
              >
                Forgot password?
              </button>
            </form>
          ) : (
            <form onSubmit={handleForgot} className="space-y-4">
              <p className="text-sm" style={{ color: 'rgba(255,255,255,0.5)' }}>
                Enter your email and we&apos;ll send a password reset link.
              </p>
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-widest mb-1.5"
                  style={{ color: 'rgba(255,255,255,0.35)' }}>
                  Email
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="w-full px-3 py-2.5 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold transition-colors"
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                />
              </div>
              {error && <p className="text-xs" style={{ color: '#f87171' }}>{error}</p>}
              {message && <p className="text-xs" style={{ color: '#4ade80' }}>{message}</p>}
              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50 transition-all mt-2"
                style={{ background: '#c9a84c', color: '#0a0a0a' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#a88930')}
                onMouseLeave={e => (e.currentTarget.style.background = '#c9a84c')}
              >
                {loading ? 'Sending…' : 'Send reset link'}
              </button>
              <button
                type="button"
                onClick={() => { setMode('login'); setError(''); setMessage('') }}
                className="w-full text-xs text-center pt-1 transition-colors"
                style={{ color: 'rgba(255,255,255,0.3)' }}
                onMouseEnter={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.6)')}
                onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.3)')}
              >
                Back to sign in
              </button>
            </form>
          )}
        </div>

        <p className="text-xs text-center mt-5" style={{ color: 'rgba(255,255,255,0.2)' }}>
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
