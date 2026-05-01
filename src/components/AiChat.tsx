'use client'

import { useState, useRef, useEffect } from 'react'
import { MessageCircle, X, Sparkles, Send, History, Trash2, ChevronLeft, Plus } from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { useDrawer } from '@/contexts/DrawerContext'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

interface ConversationSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  _count: { messages: number }
}

// ── Lightweight markdown renderer (no extra dependencies) ─────────────────────
// Handles: **bold**, *italic*, `code`, - bullet lists, numbered lists, blank lines

function parseInline(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g)
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**'))
      return <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>
    if (part.startsWith('*') && part.endsWith('*'))
      return <em key={i}>{part.slice(1, -1)}</em>
    if (part.startsWith('`') && part.endsWith('`'))
      return <code key={i} className="bg-black/10 rounded px-1 text-[11px] font-mono">{part.slice(1, -1)}</code>
    return part
  })
}

function MarkdownContent({ content, isUser }: { content: string; isUser: boolean }) {
  const lines = content.split('\n')
  const nodes: React.ReactNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Bullet list item
    if (/^[-•*]\s+/.test(line)) {
      const items: React.ReactNode[] = []
      while (i < lines.length && /^[-•*]\s+/.test(lines[i])) {
        items.push(<li key={i}>{parseInline(lines[i].replace(/^[-•*]\s+/, ''))}</li>)
        i++
      }
      nodes.push(<ul key={`ul${i}`} className="list-disc pl-4 space-y-0.5 my-1">{items}</ul>)
      continue
    }

    // Numbered list item
    if (/^\d+\.\s+/.test(line)) {
      const items: React.ReactNode[] = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(<li key={i}>{parseInline(lines[i].replace(/^\d+\.\s+/, ''))}</li>)
        i++
      }
      nodes.push(<ol key={`ol${i}`} className="list-decimal pl-4 space-y-0.5 my-1">{items}</ol>)
      continue
    }

    // Blank line → small spacer
    if (line.trim() === '') {
      if (nodes.length > 0) nodes.push(<div key={`sp${i}`} className="h-1" />)
      i++; continue
    }

    // Normal paragraph line
    nodes.push(<p key={i} className="leading-relaxed">{parseInline(line)}</p>)
    i++
  }

  return (
    <div className={`space-y-0.5 text-sm ${isUser ? 'text-white' : 'text-gray-800'}`}>
      {nodes}
    </div>
  )
}

const QUICK_PROMPTS = [
  "What's out of stock?",
  'Any invoices to review?',
  'Show high food cost recipes',
  'How do I add a new invoice?',
]

function ThinkingDots() {
  return (
    <div className="flex items-center gap-1 px-3 py-2">
      <span className="w-2 h-2 rounded-full bg-gray-400 animate-bounce [animation-delay:-0.3s]" />
      <span className="w-2 h-2 rounded-full bg-gray-400 animate-bounce [animation-delay:-0.15s]" />
      <span className="w-2 h-2 rounded-full bg-gray-400 animate-bounce" />
    </div>
  )
}

export function AiChat() {
  const { activeRcId, activeRc } = useRc()
  const { isAnyDrawerOpen } = useDrawer()
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [view, setView] = useState<'chat' | 'history'>('chat')
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [loadingHistory, setLoadingHistory] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, open])

  useEffect(() => {
    if (open && view === 'chat') {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [open, view])

  const startNewConversation = () => {
    setMessages([])
    setConversationId(null)
    setView('chat')
    setInput('')
    setTimeout(() => inputRef.current?.focus(), 100)
  }

  const loadHistory = async () => {
    setView('history')
    setLoadingHistory(true)
    try {
      const res = await fetch('/api/chat/conversations')
      const data = await res.json()
      setConversations(data)
    } finally {
      setLoadingHistory(false)
    }
  }

  const loadConversation = async (id: string) => {
    const res = await fetch(`/api/chat/conversations/${id}`)
    const data = await res.json()
    setMessages(data.messages.map((m: { role: 'user' | 'assistant'; content: string }) => ({
      role: m.role,
      content: m.content,
    })))
    setConversationId(id)
    setView('chat')
  }

  const deleteConversation = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    await fetch(`/api/chat/conversations/${id}`, { method: 'DELETE' })
    setConversations(prev => prev.filter(c => c.id !== id))
    if (conversationId === id) startNewConversation()
  }

  const sendMessage = async (content: string) => {
    if (!content.trim() || loading) return
    const userMsg: Message = { role: 'user', content: content.trim() }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setInput('')
    setLoading(true)
    setMessages(prev => [...prev, { role: 'assistant', content: '' }])

    // Create conversation on first message
    let convId = conversationId
    if (!convId) {
      try {
        const res = await fetch('/api/chat/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: content.trim().slice(0, 80) }),
        })
        const conv = await res.json()
        convId = conv.id
        setConversationId(convId)
      } catch { /* non-fatal */ }
    }

    let assistantContent = ''
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newMessages,
          rcId: activeRcId,
          isDefault: activeRc?.isDefault ?? false,
        }),
      })
      if (!res.body) throw new Error('No body')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        assistantContent += chunk
        setMessages(prev => {
          const copy = [...prev]
          copy[copy.length - 1] = { ...copy[copy.length - 1], content: copy[copy.length - 1].content + chunk }
          return copy
        })
      }
    } catch {
      assistantContent = 'Sorry, something went wrong. Please try again.'
      setMessages(prev => {
        const copy = [...prev]
        copy[copy.length - 1] = { ...copy[copy.length - 1], content: assistantContent }
        return copy
      })
    } finally {
      setLoading(false)
    }

    // Save messages to DB
    if (convId && assistantContent) {
      fetch(`/api/chat/conversations/${convId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([
          { role: 'user', content: content.trim() },
          { role: 'assistant', content: assistantContent },
        ]),
      }).catch(() => {})
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(input)
    }
  }

  return (
    <div className={`fixed bottom-20 right-4 sm:bottom-6 sm:right-6 z-[55] ${isAnyDrawerOpen ? 'hidden' : ''}`}>
      {/* Chat panel */}
      {open && (
        <div className="absolute bottom-16 right-0 w-[calc(100vw-32px)] sm:w-96 max-h-[70vh] sm:max-h-[600px] bg-white rounded-2xl shadow-2xl border border-gray-100 flex flex-col overflow-hidden">
          {/* Header */}
          <div className="shrink-0 bg-gradient-to-r from-blue-600 to-blue-700 px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              {/* New conversation button */}
              <button
                onClick={startNewConversation}
                title="New conversation"
                className="text-blue-200 hover:text-white transition-colors p-0.5 rounded"
              >
                <Plus size={16} />
              </button>
              <Sparkles className="text-white" size={16} />
              <div>
                <div className="text-white font-bold text-sm leading-tight">CONTROLA</div>
                <div className="text-blue-200 text-xs">Your restaurant assistant</div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {/* History toggle */}
              <button
                onClick={view === 'history' ? () => setView('chat') : loadHistory}
                title={view === 'history' ? 'Back to chat' : 'Conversation history'}
                className="text-blue-200 hover:text-white transition-colors p-1 rounded"
              >
                {view === 'history' ? <ChevronLeft size={18} /> : <History size={18} />}
              </button>
              <button
                onClick={() => setOpen(false)}
                className="text-white hover:text-blue-200 transition-colors p-1"
                aria-label="Close chat"
              >
                <X size={18} />
              </button>
            </div>
          </div>

          {view === 'history' ? (
            /* History view */
            <div className="flex-1 overflow-y-auto">
              {loadingHistory ? (
                <div className="flex items-center justify-center py-12">
                  <div className="flex gap-1">
                    <span className="w-2 h-2 rounded-full bg-gray-300 animate-bounce [animation-delay:-0.3s]" />
                    <span className="w-2 h-2 rounded-full bg-gray-300 animate-bounce [animation-delay:-0.15s]" />
                    <span className="w-2 h-2 rounded-full bg-gray-300 animate-bounce" />
                  </div>
                </div>
              ) : conversations.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
                  <History size={32} className="text-gray-300 mb-3" />
                  <p className="text-sm text-gray-500">No conversations yet</p>
                  <p className="text-xs text-gray-400 mt-1">Start chatting to build your history</p>
                </div>
              ) : (
                <div className="divide-y divide-gray-50">
                  {conversations.map(conv => (
                    <button
                      key={conv.id}
                      onClick={() => loadConversation(conv.id)}
                      className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors text-left group"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-800 truncate">{conv.title}</p>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {new Date(conv.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          {' · '}{conv._count.messages} messages
                        </p>
                      </div>
                      <button
                        onClick={(e) => deleteConversation(conv.id, e)}
                        className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-all shrink-0"
                        title="Delete conversation"
                      >
                        <Trash2 size={14} />
                      </button>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <>
              {/* Messages */}
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {messages.length === 0 ? (
                  <div className="space-y-3">
                    <div className="bg-gray-100 text-gray-800 rounded-2xl rounded-bl-sm px-3 py-2 text-sm mr-8 self-start">
                      Hi! I&apos;m CONTROLA, your restaurant back-office assistant. I can answer questions about your inventory, invoices, recipes, sales, and more. What would you like to know?
                    </div>
                    <div className="space-y-2 pt-1">
                      {QUICK_PROMPTS.map(prompt => (
                        <button
                          key={prompt}
                          onClick={() => sendMessage(prompt)}
                          className="w-full text-left text-sm px-3 py-2 rounded-xl border border-gray-200 hover:border-blue-300 hover:bg-gold/10 text-gray-700 transition-colors"
                        >
                          {prompt}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((msg, i) => (
                    <div
                      key={i}
                      className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                    >
                      {msg.role === 'assistant' && msg.content === '' && loading && i === messages.length - 1 ? (
                        <div className="bg-gray-100 rounded-2xl rounded-bl-sm mr-8">
                          <ThinkingDots />
                        </div>
                      ) : (
                        <div
                          className={
                            msg.role === 'user'
                              ? 'bg-gold rounded-2xl rounded-br-sm px-3 py-2 ml-8 max-w-[85%]'
                              : 'bg-gray-100 rounded-2xl rounded-bl-sm px-3 py-2 mr-8 max-w-[85%]'
                          }
                        >
                          <MarkdownContent content={msg.content} isUser={msg.role === 'user'} />
                        </div>
                      )}
                    </div>
                  ))
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Input area */}
              <div className="shrink-0 border-t border-gray-100 p-3">
                <div className="flex gap-2 items-center">
                  <input
                    ref={inputRef}
                    type="text"
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Ask anything..."
                    disabled={loading}
                    className="flex-1 min-w-0 text-sm px-3 py-2 rounded-xl border border-gray-200 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-gold disabled:opacity-50"
                  />
                  <button
                    onClick={() => sendMessage(input)}
                    disabled={loading || !input.trim()}
                    className="shrink-0 w-9 h-9 rounded-full bg-gold hover:bg-[#a88930] disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
                    aria-label="Send message"
                  >
                    <Send size={16} className="text-white" />
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* Toggle button */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-[52px] h-[52px] rounded-full bg-gradient-to-br from-blue-600 to-blue-700 shadow-lg flex items-center justify-center hover:shadow-xl transition-shadow"
        aria-label={open ? 'Close CONTROLA chat' : 'Open CONTROLA chat'}
      >
        {open ? (
          <X size={22} className="text-white" />
        ) : (
          <MessageCircle size={22} className="text-white" />
        )}
      </button>
    </div>
  )
}
