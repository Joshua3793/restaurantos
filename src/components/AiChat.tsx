'use client'

import { useState, useRef, useEffect } from 'react'
import { MessageCircle, X, Sparkles, Send } from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'

interface Message {
  role: 'user' | 'assistant'
  content: string
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
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, open])

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [open])

  const sendMessage = async (content: string) => {
    if (!content.trim() || loading) return
    const userMsg: Message = { role: 'user', content: content.trim() }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setInput('')
    setLoading(true)

    // Add empty assistant message to stream into
    setMessages(prev => [...prev, { role: 'assistant', content: '' }])

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
        setMessages(prev => {
          const copy = [...prev]
          copy[copy.length - 1] = {
            ...copy[copy.length - 1],
            content: copy[copy.length - 1].content + chunk,
          }
          return copy
        })
      }
    } catch {
      setMessages(prev => {
        const copy = [...prev]
        copy[copy.length - 1] = {
          ...copy[copy.length - 1],
          content: 'Sorry, something went wrong. Please try again.',
        }
        return copy
      })
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(input)
    }
  }

  return (
    <div className="fixed bottom-20 right-4 sm:bottom-6 sm:right-6 z-[55]">
      {/* Chat panel */}
      {open && (
        <div className="absolute bottom-16 right-0 w-[calc(100vw-32px)] sm:w-96 max-h-[70vh] sm:max-h-[600px] bg-white rounded-2xl shadow-2xl border border-gray-100 flex flex-col overflow-hidden">
          {/* Header */}
          <div className="shrink-0 bg-gradient-to-r from-blue-600 to-blue-700 px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="text-white" size={18} />
              <div>
                <div className="text-white font-bold text-sm leading-tight">CONTROLA</div>
                <div className="text-blue-200 text-xs">Your restaurant assistant</div>
              </div>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="text-white hover:text-blue-200 transition-colors p-1"
              aria-label="Close chat"
            >
              <X size={18} />
            </button>
          </div>

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
                      className="w-full text-left text-sm px-3 py-2 rounded-xl border border-gray-200 hover:border-blue-300 hover:bg-blue-50 text-gray-700 transition-colors"
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
                          ? 'bg-blue-600 text-white rounded-2xl rounded-br-sm px-3 py-2 text-sm ml-8 max-w-[85%] whitespace-pre-wrap'
                          : 'bg-gray-100 text-gray-800 rounded-2xl rounded-bl-sm px-3 py-2 text-sm mr-8 max-w-[85%] whitespace-pre-wrap'
                      }
                    >
                      {msg.content}
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
                className="flex-1 min-w-0 text-sm px-3 py-2 rounded-xl border border-gray-200 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400 disabled:opacity-50"
              />
              <button
                onClick={() => sendMessage(input)}
                disabled={loading || !input.trim()}
                className="shrink-0 w-9 h-9 rounded-full bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
                aria-label="Send message"
              >
                <Send size={16} className="text-white" />
              </button>
            </div>
          </div>
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
