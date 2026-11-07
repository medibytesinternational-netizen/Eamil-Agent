import { ChevronRight, RotateCcw, SendHorizontal } from 'lucide-react'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { ScreenHeader, VoiceButton, voiceLabel } from '../components/ui'
import type { useChat } from '../hooks/useChat'

const PROMPTS = [
  'Anything urgent today?',
  'Which bills are due this week?',
  "Who's waiting on my reply?",
  'Find my latest bank statement',
]

export type AskHandle = { prefill: (text: string) => void }

// Minimal formatting for agent replies: **bold** and "- " bullets as "•". No HTML injection (React escapes text).
function Rich({ text }: { text: string }) {
  const lines = text.replace(/^\s*[-*] /gm, '• ').split(/(\*\*[^*]+\*\*)/g)
  return <>{lines.map((part, i) => part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part)}</>
}

export const Ask = forwardRef<AskHandle, { chat: ReturnType<typeof useChat>; onBack?: () => void }>(function Ask({ chat, onBack }, ref) {
  const { messages, busy, toolChip, voiceState, ask, toggleVoice, clear } = chat
  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)

  useImperativeHandle(ref, () => ({ prefill: text => { setInput(text); inputRef.current?.focus() } }))
  useEffect(() => { threadRef.current?.scrollTo(0, threadRef.current.scrollHeight) }, [messages, toolChip])

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const t = input.trim()
    if (!t || busy) return
    setInput('')
    ask(t)
  }
  const started = messages.length > 0

  return (
    <div className="screen ask">
      <ScreenHeader title="Ask AI" onBack={onBack}
        right={started ? <button className="round-btn" onClick={clear} aria-label="New conversation"><RotateCcw size={16} /></button> : undefined} />

      <div className="ask-body" ref={threadRef}>
        {!started && (
          <div className="ask-hero">
            <h1>Ask anything<br />about your email.</h1>
            <p>Get instant answers, find old mail, and draft replies you send yourself.</p>
          </div>
        )}
        {started && (
          <div className="thread" aria-live="polite">
            {messages.map((m, i) => <div key={i} className={`bubble ${m.role} ${m.pending ? 'pending' : ''}`}>{m.role === 'agent' ? <Rich text={m.text} /> : m.text}</div>)}
            {toolChip && <div className="chip">{toolChip}</div>}
          </div>
        )}
        {!started && (
          <div className="prompts">
            <h3>Try these prompts</h3>
            {PROMPTS.map(p => (
              <button key={p} className="prompt glass" onClick={() => ask(p)}>{p}<ChevronRight size={16} aria-hidden /></button>
            ))}
          </div>
        )}
      </div>

      <form className="composer glass" onSubmit={submit}>
        <input ref={inputRef} value={input} onChange={e => setInput(e.target.value)} placeholder="Ask about your email…"
          aria-label="Message" disabled={busy} data-chat-input />
        <div className="composer-bar">
          <small>{voiceState === 'idle' ? 'Drafts only — never sends' : voiceLabel(voiceState)}</small>
          <div className="composer-actions">
            <VoiceButton state={voiceState} onClick={toggleVoice} />
            <button type="submit" className="send-btn" aria-label="Send" disabled={busy || !input.trim()}><SendHorizontal size={16} /></button>
          </div>
        </div>
      </form>
    </div>
  )
})
