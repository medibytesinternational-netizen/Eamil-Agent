import { AlertTriangle, ArrowUp, Menu, PenLine, Reply, SendHorizontal, Sparkles, SquarePen, Wallet } from 'lucide-react'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { VoiceButton, voiceLabel } from '../components/ui'
import type { useChat } from '../hooks/useChat'

const CHIPS: { label: string; icon: typeof Sparkles; text: string; prefill?: boolean }[] = [
  { label: 'Urgent today', icon: AlertTriangle, text: 'Anything urgent today?' },
  { label: 'Bills due', icon: Wallet, text: 'Which bills are due this week?' },
  { label: 'Waiting on me', icon: Reply, text: "Who's waiting on my reply?" },
  { label: 'Draft a reply', icon: PenLine, text: 'Draft a reply to ', prefill: true },
]

export type ChatHandle = { prefill: (text: string) => void }

// **bold** and "- " bullets only; React escapes everything else.
function Rich({ text }: { text: string }) {
  const parts = text.replace(/^\s*[-*] /gm, '• ').split(/(\*\*[^*]+\*\*)/g)
  return <>{parts.map((p, i) => p.startsWith('**') && p.endsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : p)}</>
}

function greeting() {
  const h = new Date().getHours()
  return h < 12 ? 'Good Morning' : h < 17 ? 'Good Afternoon' : 'Good Evening'
}

export const Chat = forwardRef<ChatHandle, { chat: ReturnType<typeof useChat>; name: string; onMenu: () => void }>(
  function Chat({ chat, name, onMenu }, ref) {
    const { messages, busy, toolChip, voiceState, ask, toggleVoice, clear } = chat
    const [input, setInput] = useState('')
    const inputRef = useRef<HTMLTextAreaElement>(null)
    const endRef = useRef<HTMLDivElement>(null)

    const focus = (t: string) => { setInput(t); setTimeout(() => { const el = inputRef.current; el?.focus(); el?.setSelectionRange(t.length, t.length) }, 30) }
    useImperativeHandle(ref, () => ({ prefill: focus }))
    useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [messages, toolChip])

    const send = () => {
      const t = input.trim()
      if (!t || busy) return
      setInput('')
      ask(t)
    }
    const empty = messages.length === 0
    const status = voiceState !== 'idle' ? voiceLabel(voiceState) : busy ? 'Thinking…' : 'Online'

    const chips = (cls: string) => (
      <div className={`ai-chips ${cls}`}>
        {CHIPS.map(c => (
          <button type="button" key={c.label} className="ai-chip" onClick={() => (c.prefill ? focus(c.text) : ask(c.text))} disabled={busy}>
            <c.icon size={15} aria-hidden /><span>{c.label}</span>
          </button>
        ))}
      </div>
    )

    return (
      <div className="agent-page">
        <div className={`ai-card ${empty ? 'is-empty' : ''}`}>
          <header className="ai-top">
            <button className="ai-icon-btn phone-only" onClick={onMenu} aria-label="Menu"><Menu size={18} /></button>
            <span className="ai-badge desktop-only"><span className="ring-orb sm" aria-hidden /> Inbox Agent <em>{status}</em></span>
            <span className="ai-hi phone-only">Hi, {name}<small>{status}</small></span>
            <button className="ai-icon-btn" onClick={clear} disabled={empty} aria-label="New chat" title="New chat"><SquarePen size={17} /></button>
          </header>

          <div className="ai-thread" aria-live="polite">
            {empty ? (
              <div className="ai-hero">
                <span className="ring-orb desktop-only" aria-hidden />
                <span className="app-tile phone-only" aria-hidden><Sparkles size={30} strokeWidth={2.4} /></span>
                <h1 className="desktop-only">{greeting()}, {name}! How<br />can I assist you?</h1>
                <h1 className="phone-only">How May I Assist<br />You Today?</h1>
              </div>
            ) : (
              <div className="ai-messages">
                {messages.map((m, i) => (
                  <div key={i} className={`msg ${m.role} ${m.pending ? 'pending' : ''}`}>
                    {m.role === 'agent' && <span className="ring-orb xs" aria-hidden />}
                    <div className="bubble">{m.role === 'agent' ? <Rich text={m.text} /> : m.text}</div>
                  </div>
                ))}
                {toolChip && (
                  <div className="msg agent"><span className="ring-orb xs spin" aria-hidden />
                    <div className="bubble typing"><span /><span /><span /><em>{toolChip}</em></div></div>
                )}
                <div ref={endRef} />
              </div>
            )}

            <div className="ai-bottom">
              {chips('phone-only')}
              <form className="ai-composer" onSubmit={e => { e.preventDefault(); send() }}>
                <div className="ai-input">
                  <Sparkles size={17} aria-hidden className="desktop-only" />
                  <textarea ref={inputRef} rows={empty ? 3 : 1} value={input} onChange={e => setInput(e.target.value)}
                    placeholder="Start your request, and let your agent handle everything." aria-label="Message" data-chat-input
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
                </div>
                <div className="ai-tools">
                  {chips('desktop-only')}
                  <span className="ai-note phone-only">Drafts only · never sends</span>
                  <div className="ai-actions">
                    <VoiceButton state={voiceState} onClick={toggleVoice} />
                    <button type="submit" className="ai-send" aria-label="Send" disabled={busy || !input.trim()}>
                      <SendHorizontal size={18} className="desktop-only" /><ArrowUp size={18} strokeWidth={2.6} className="phone-only" />
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>
    )
  })
