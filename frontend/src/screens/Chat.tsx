import { AlertTriangle, ArrowUp, PenLine, Reply, Sparkles, SquarePen, Wallet } from 'lucide-react'
import { BotAvatar } from 'bot-avatars'
import { VoiceBeam } from 'voice-glow'
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


export const Chat = forwardRef<ChatHandle, { chat: ReturnType<typeof useChat>; name: string }>(
  function Chat({ chat, name }, ref) {
    const { messages, busy, toolChip, voiceState, micStream, ask, toggleVoice, clear } = chat
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
            <button className="ai-icon-btn" onClick={clear} disabled={empty} aria-label="New chat" title="New chat"><SquarePen size={17} /></button>
          </header>

          <div className="ai-thread" aria-live="polite">
            {empty ? (
              <div className="ai-hero">
                <BotAvatar type="flower" size={96} state={busy || voiceState !== 'idle' ? 'working' : 'default'} aria-hidden />
                <h1>Hi, {name}</h1>
                <p className="ai-status">{status}</p>
              </div>
            ) : (
              <div className="ai-messages">
                {messages.map((m, i) => (
                  <div key={i} className={`msg ${m.role} ${m.pending ? 'pending' : ''}`}>
                    {m.role === 'agent' && <span className="msg-avatar" aria-hidden><BotAvatar type="flower" size={34} /></span>}
                    <div className="bubble">{m.role === 'agent' ? <Rich text={m.text} /> : m.text}</div>
                  </div>
                ))}
                {toolChip && (
                  <div className="msg agent"><span className="msg-avatar" aria-hidden><BotAvatar type="flower" size={34} state="working" /></span>
                    <div className="bubble typing"><span /><span /><span /><em>{toolChip}</em></div></div>
                )}
                <div ref={endRef} />
              </div>
            )}

            <div className="ai-bottom">
              {chips('')}
              <VoiceBeam stream={micStream} active={!!micStream} colorVariant="forest"
                theme={document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'}>
              <form className="ai-composer" onSubmit={e => { e.preventDefault(); send() }}>
                <div className="ai-input">
                  <textarea ref={inputRef} rows={empty ? 3 : 1} value={input} onChange={e => setInput(e.target.value)}
                    placeholder="Start your request, and let your agent handle everything." aria-label="Message" data-chat-input
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
                </div>
                <div className="ai-tools">
                  <span className="ai-note">Drafts only · never sends</span>
                  <div className="ai-actions">
                    <VoiceButton state={voiceState} onClick={toggleVoice} />
                    <button type="submit" className="ai-send" aria-label="Send" disabled={busy || !input.trim()}>
                      <ArrowUp size={18} strokeWidth={2.6} />
                    </button>
                  </div>
                </div>
              </form>
              </VoiceBeam>
            </div>
          </div>
        </div>
      </div>
    )
  })

