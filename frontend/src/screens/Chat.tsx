import { ArrowUp, SquarePen } from 'lucide-react'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { VoiceButton, voiceLabel } from '../components/ui'
import type { useChat } from '../hooks/useChat'

const SUGGESTIONS = [
  'Anything urgent today?',
  'Which bills are due this week?',
  "Who's waiting on my reply?",
  'Find my latest bank statement',
]

export type ChatHandle = { prefill: (text: string) => void }

// **bold** and "- " bullets only; React escapes everything else.
function Rich({ text }: { text: string }) {
  const parts = text.replace(/^\s*[-*] /gm, '• ').split(/(\*\*[^*]+\*\*)/g)
  return <>{parts.map((p, i) => p.startsWith('**') && p.endsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : p)}</>
}

export const Chat = forwardRef<ChatHandle, { chat: ReturnType<typeof useChat> }>(function Chat({ chat }, ref) {
  const { messages, busy, toolChip, voiceState, ask, toggleVoice, clear } = chat
  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const endRef = useRef<HTMLDivElement>(null)

  useImperativeHandle(ref, () => ({ prefill: t => { setInput(t); setTimeout(() => inputRef.current?.focus(), 30) } }))
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [messages, toolChip])
  useEffect(() => {
    const el = inputRef.current
    if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 140)}px` }
  }, [input])

  const send = () => {
    const t = input.trim()
    if (!t || busy) return
    setInput('')
    ask(t)
  }
  const empty = messages.length === 0

  return (
    <div className="agent-page">
      <div className="card agent-card">
        <header className="agent-head">
          <div>
            <h1>Agent</h1>
            <p>{voiceState === 'idle' ? (busy ? 'Thinking…' : 'Searches, reads and drafts — never sends') : voiceLabel(voiceState)}</p>
          </div>
          <button className="btn outline sm" onClick={clear} disabled={empty}><SquarePen size={14} /> New chat</button>
        </header>

        <div className="thread" aria-live="polite">
          {empty && (
            <div className="chat-empty">
              <div className="orb" aria-hidden />
              <h2>How can I help with your email?</h2>
              <div className="suggestions">
                {SUGGESTIONS.map(s => <button key={s} className="suggestion" onClick={() => ask(s)}>{s}</button>)}
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role} ${m.pending ? 'pending' : ''}`}>
              <div className="bubble">{m.role === 'agent' ? <Rich text={m.text} /> : m.text}</div>
            </div>
          ))}
          {toolChip && <div className="msg agent"><div className="bubble typing"><span /><span /><span /><em>{toolChip}</em></div></div>}
          <div ref={endRef} />
        </div>

        <form className="composer" onSubmit={e => { e.preventDefault(); send() }}>
          <textarea ref={inputRef} rows={1} value={input} onChange={e => setInput(e.target.value)} placeholder="Ask about your email…"
            aria-label="Message" data-chat-input
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
          <VoiceButton state={voiceState} onClick={toggleVoice} />
          <button type="submit" className="send-btn" aria-label="Send" disabled={busy || !input.trim()}><ArrowUp size={18} strokeWidth={2.6} /></button>
        </form>
      </div>
    </div>
  )
})
