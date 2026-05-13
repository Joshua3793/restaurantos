'use client'
import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────────────────

type ToastType = 'success' | 'error' | 'warning' | 'info'

export interface ToastOptions {
  type?: ToastType
  title: string
  message?: string
  duration?: number
}

interface ToastContextValue {
  show: (opts: ToastOptions) => string
  dismiss: (id: string) => void
}

interface ToastItem {
  id: string
  type: ToastType
  title: string
  message?: string
  duration: number
  phase: 'entering' | 'visible' | 'exiting'
}

// ── Context ────────────────────────────────────────────────────────────────────

const ToastContext = createContext<ToastContextValue>({
  show: () => '',
  dismiss: () => {},
})

export const useToast = () => useContext(ToastContext)

// ── Accent colors ──────────────────────────────────────────────────────────────

const ACCENT: Record<ToastType, string> = {
  success: '#00ff88',
  error:   '#ff6b6b',
  warning: '#ffc700',
  info:    '#00c4ff',
}

// ── ToastItem (internal) ───────────────────────────────────────────────────────

function ToastItemComponent({
  toast,
  onDismiss,
}: {
  toast: ToastItem
  onDismiss: (id: string) => void
}) {
  const timerRef  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startRef  = useRef<number>(Date.now())
  const remaining = useRef<number>(toast.duration)
  const [paused, setPaused] = useState(false)

  const startTimer = useCallback(() => {
    startRef.current = Date.now()
    timerRef.current = setTimeout(() => onDismiss(toast.id), remaining.current)
  }, [toast.id, onDismiss])

  useEffect(() => {
    startTimer()
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [startTimer])

  const handleMouseEnter = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    remaining.current = Math.max(0, remaining.current - (Date.now() - startRef.current))
    setPaused(true)
  }

  const handleMouseLeave = () => {
    setPaused(false)
    startTimer()
  }

  const Icon =
    toast.type === 'success' ? CheckCircle2 :
    toast.type === 'error'   ? XCircle :
    toast.type === 'warning' ? AlertTriangle :
    Info

  const accent = ACCENT[toast.type]

  const phaseClass =
    toast.phase === 'visible'  ? 'toast-item--visible'  :
    toast.phase === 'exiting'  ? 'toast-item--exiting'  :
    'toast-item--entering'

  return (
    <div
      className={`toast-item ${phaseClass}`}
      style={{ '--accent': accent } as React.CSSProperties}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      role="alert"
    >
      {/* Left accent stripe */}
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: accent, borderRadius: '10px 0 0 10px' }} />

      {/* Icon */}
      <div style={{ flexShrink: 0, marginTop: 1, paddingLeft: 6 }}>
        <Icon size={16} color={accent} />
      </div>

      {/* Text */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="toast-title">{toast.title}</div>
        {toast.message && <div className="toast-message">{toast.message}</div>}
      </div>

      {/* Close */}
      <button
        className="toast-close"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
        style={{ flexShrink: 0 }}
      >
        <X size={12} />
      </button>

      {/* Progress bar */}
      <div className="toast-progress">
        <div
          className="toast-progress-fill"
          style={{
            '--duration': `${toast.duration}ms`,
            background: accent,
            animationPlayState: paused ? 'paused' : 'running',
          } as React.CSSProperties}
        />
      </div>
    </div>
  )
}

// ── ToastStack (internal) ──────────────────────────────────────────────────────

function ToastStack({
  toasts,
  dismiss,
}: {
  toasts: ToastItem[]
  dismiss: (id: string) => void
}) {
  return (
    <div
      role="log"
      aria-live="polite"
      aria-label="Notifications"
      style={{
        position: 'fixed',
        top: 16,
        right: 16,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        width: 'min(360px, calc(100vw - 32px))',
        pointerEvents: 'none',
      }}
    >
      {toasts.map(t => (
        <ToastItemComponent key={t.id} toast={t} onDismiss={dismiss} />
      ))}
    </div>
  )
}

// ── ToastProvider ──────────────────────────────────────────────────────────────

let _counter = 0

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [mounted, setMounted] = useState(false)

  useEffect(() => { setMounted(true) }, [])

  const dismiss = useCallback((id: string) => {
    // Flip to exiting
    setToasts(prev =>
      prev.map(t => t.id === id ? { ...t, phase: 'exiting' as const } : t)
    )
    // Remove after exit animation
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, 320)
  }, [])

  const show = useCallback((opts: ToastOptions): string => {
    _counter++
    const id = `toast-${_counter}`
    const item: ToastItem = {
      id,
      type: opts.type ?? 'info',
      title: opts.title,
      message: opts.message,
      duration: opts.duration ?? 5000,
      phase: 'entering',
    }

    setToasts(prev => {
      const next = [...prev, item]
      // Max 5 — trim oldest if over limit
      if (next.length > 5) {
        const trimmed = next.slice(next.length - 5)
        return trimmed
      }
      return next
    })

    // Double rAF to flip entering → visible after paint
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setToasts(prev =>
          prev.map(t => t.id === id ? { ...t, phase: 'visible' as const } : t)
        )
      })
    })

    return id
  }, [])

  return (
    <ToastContext.Provider value={{ show, dismiss }}>
      {children}
      {mounted && typeof window !== 'undefined' &&
        createPortal(<ToastStack toasts={toasts} dismiss={dismiss} />, document.body)
      }
    </ToastContext.Provider>
  )
}
