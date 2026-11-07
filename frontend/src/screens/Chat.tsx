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
    <div className="page chat">
      <header className="nav-bar">
        <span className="nav-spacer" />
        <div className="nav-title">
          <strong>Inbox Assistant</strong>
          <small>{voiceState === 'idle' ? (busy ? 'Thinking…' : 'Drafts only — never sends') : voiceLabel(voiceState)}</small>
        </div>
        <button className="circle-btn plain" onClick={clear} disabled={empty} aria-label="New chat"><SquarePen size={18} /></button>
      </header>

      <div className="thread" aria-live="polite">
        {empty && (
          <div className="chat-empty">
            <div className="orb" aria-hidden />
            <h1>How can I help?</h1>
            <p>Ask about your email, find old messages, or have me draft a reply for you to send.</p>
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

      <div className="composer-wrap">
        <form className="composer" onSubmit={e => { e.preventDefault(); send() }}>
          <textarea ref={inputRef} rows={1} value={input} onChange={e => setInput(e.target.value)} placeholder="Message"
            aria-label="Message" data-chat-input
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
          {input.trim()
            ? <button type="submit" className="send-btn" aria-label="Send" disabled={busy}><ArrowUp size={18} strokeWidth={2.6} /></button>
            : <VoiceButton state={voiceState} onClick={toggleVoice} />}
        </form>
      </div>
    </div>
  )
})
