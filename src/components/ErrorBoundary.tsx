'use client'
/**
 * ErrorBoundary — catches render/runtime errors in its subtree and shows a small
 * recoverable notice instead of letting the whole page white-screen. Use it to wrap
 * volatile subtrees (modals, drawers) whose data may be partial — e.g. when offline a
 * recipe fetch can resolve to an error-shaped body and a downstream `.map` would throw.
 *
 * `resetKeys` lets the parent clear the error when the relevant inputs change (e.g. the
 * open item id) so re-opening a drawer works without a full reload.
 */
import { Component, ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Rendered in place of the subtree when it has thrown. */
  fallback?: ReactNode
  /** When any value here changes, the boundary clears its error and retries the subtree. */
  resetKeys?: unknown[]
  /** Optional side-channel for logging/telemetry. */
  onError?: (error: Error) => void
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error): void {
    // Keep it visible in dev; swallow in prod so a modal glitch never nukes the page.
    console.error('ErrorBoundary caught:', error)
    this.props.onError?.(error)
  }

  componentDidUpdate(prev: Props): void {
    if (!this.state.error) return
    const a = prev.resetKeys ?? []
    const b = this.props.resetKeys ?? []
    if (a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]))) {
      this.setState({ error: null })
    }
  }

  render(): ReactNode {
    if (this.state.error) return this.props.fallback ?? null
    return this.props.children
  }
}

export default ErrorBoundary
