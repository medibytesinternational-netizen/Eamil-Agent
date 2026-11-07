import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import { api, AuthError, enablePush } from './lib/api'
import { VoiceSession, type VoiceState } from './lib/realtime'

type Urgent = { id: number; thread_id: string; category: string | null; sender: string; summary: string | null; reason: string | null; received_at: string }
type Reply = { thread_id: string; sender: string; summary: string | null; received_at: string }
type DraftItem = { draft_id: string; thread_id: string | null; to: string | null; subject: string | null; snippet: string | null }
type Dashboard = {
  counts: { urgent: number; needs_reply: number; drafts: number; processed_today: number; total: number }
  urgent: Urgent[]; needs_reply: Reply[]; drafts: DraftItem[]
}
type Health = {
  gmail_connected: boolean; account: string; quiet_hours: string | null; quiet_now: boolean
  backfill: { done: number; total: number } | null; last_error: string | null; vapid_public_key: string
}
type Msg = { role: 'user' | 'agent'; text: string; pending?: boolean }
type Tab = 'urgent' | 'reply' | 'drafts'

const CATEGORY_LABEL: Record<string, string> = {
  payment: 'Payment due', reply_needed: 'Reply needed', deadline: 'Deadline', security: 'Security',
}
const TOOL_LABEL: Record<string, string> = {
  search_emails: 'Searching Gmail…', read_thread: 'Reading the email…', get_urgent_items: 'Checking urgent items…',
  mark_handled: 'Updating…', list_pending_drafts: 'Checking drafts…', create_draft: 'Saving draft…',
}
const VOICE_LABEL: Record<VoiceState, string> = {
  idle: 'Start voice', connecting: 'Connecting…', listening: 'Listening — tap to end',
  thinking: 'Thinking…', speaking: 'Speaking — talk to interrupt',
}

const senderName = (s: string) => s.replace(/<.*>/, '').replace(/"/g, '').trim() || s
const gmailLink = (t: string) => `https://mail.google.com/mail/u/0/#all/${t}`

function timeAgo(iso: string) {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  if (m < 60) return `${m}m ago`
  if (m < 1440) return `${Math.round(m / 60)}h ago`
  return `${Math.round(m / 1440)}d ago`
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null)
  useEffect(() => { api('/api/me').then(r => setAuthed(r.logged_in)).catch(() => setAuthed(false)) }, [])
  if (authed === null) return null
  return authed ? <Agent onLogout={() => setAuthed(false)} /> : <Login onDone={() => setAuthed(true)} />
}

function Login({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    try { await api('/api/login', { json: { password: pw } }); onDone() } catch { setErr('Wrong password') }
  }
  return (
    <form className="login" onSubmit={submit}>
      <h1>Inbox Agent</h1>
      <label htmlFor="pw">App password</label>
      <input id="pw" type="password" value={pw} onChange={e => setPw(e.target.value)} autoFocus />
      {err && <p className="err">{err}</p>}
      <button type="submit">Sign in</button>
      <small>Set APP_PASSWORD in the project's .env file.</small>
    </form>
  )
}

function Agent({ onLogout }: { onLogout: () => void }) {
  const [health, setHealth] = useState<Health | null>(null)
  const [data, setData] = useState<Dashboard | null>(null)
  const [offline, setOffline] = useState(false)
  const [tab, setTab] = useState<Tab>('urgent')
  const [messages, setMessages] = useState<Msg[]>([
    { role: 'agent', text: 'Hi! Ask about your email — type here or tap the mic. Try “Anything urgent?”' },
  ])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [toolChip, setToolChip] = useState<string | null>(null)
  const [voiceState, setVoiceState] = useState<VoiceState>('idle')
  const [toast, setToast] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const voice = useRef<VoiceSession | null>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  const handleErr = useCallback((e: unknown) => {
    if (e instanceof AuthError) onLogout()
    else setToast(e instanceof Error ? e.message : String(e))
  }, [onLogout])

  const load = useCallback(() =>
    Promise.all([api<Health>('/api/health'), api<Dashboard>('/api/dashboard')])
      .then(([h, d]) => { setHealth(h); setData(d); setOffline(false) })
      .catch(e => { if (e instanceof AuthError) onLogout(); else setOffline(true) }), [onLogout])

  useEffect(() => {
    load()
    const es = new EventSource('/api/events')
    const refresh = () => load()
    ;['email', 'alert', 'drafts', 'status', 'backfill'].forEach(ev => es.addEventListener(ev, refresh))
    const t = setInterval(load, 60000)
    return () => { es.close(); clearInterval(t) }
  }, [load])

  useEffect(() => { threadRef.current?.scrollTo(0, threadRef.current.scrollHeight) }, [messages, toolChip])
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(''), 5000); return () => clearTimeout(t) } }, [toast])

  const recentUserText = () => messagesRef.current.filter(m => m.role === 'user').slice(-6).map(m => m.text).join(' ')
  const history = () => messagesRef.current.filter(m => !m.pending).slice(-12).map(m => ({ role: m.role, text: m.text }))

  const ask = async (text: string) => {
    setMessages(m => [...m, { role: 'user', text }])
    if (voice.current?.active && voice.current.sendText(text)) return
    setBusy(true)
    setToolChip('Thinking…')
    try {
      const r = await api<{ reply: string; tools: string[] }>('/api/chat', { json: { message: text, history: history() } })
      setMessages(m => [...m, { role: 'agent', text: r.reply }])
      if (r.tools.length) load()
    } catch (e) {
      handleErr(e)
      setMessages(m => [...m, { role: 'agent', text: 'Sorry — something went wrong. Please try again.' }])
    } finally { setBusy(false); setToolChip(null) }
  }

  const send = (e: React.FormEvent) => {
    e.preventDefault()
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    ask(text)
  }

  const toggleVoice = useCallback(() => {
    if (voice.current?.active) { voice.current.stop(); return }
    const v = new VoiceSession({
      onState: setVoiceState,
      onUserTranscript: text => setMessages(m => [...m, { role: 'user', text }]),
      onAgentTranscript: (text, done) => setMessages(m => {
        const last = m[m.length - 1]
        const next = last?.role === 'agent' && last.pending ? m.slice(0, -1) : m
        return [...next, { role: 'agent', text, pending: !done }]
      }),
      onTool: name => { setToolChip(name ? TOOL_LABEL[name] ?? 'Working…' : null); if (!name) load() },
      onError: msg => setToast(msg),
      onEnded: () => { voice.current = null; setToolChip(null) },
      recentUserText,
    })
    voice.current = v
    v.start(history())
  }, [load])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (e.code === 'Space' && !e.repeat && !['INPUT', 'TEXTAREA', 'BUTTON'].includes(el.tagName)) {
        e.preventDefault(); toggleVoice()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); voice.current?.stop() }
  }, [toggleVoice])

  const feedback = async (id: number, action: string) => {
    try { await api(`/api/alerts/${id}/feedback`, { json: { action } }); load() } catch (e) { handleErr(e) }
  }
  const discard = async (id: string) => {
    try { await api(`/api/drafts/${id}/discard`, { method: 'POST' }); load() } catch (e) { handleErr(e) }
  }
  const pushOn = async () => {
    if (!health?.vapid_public_key) return
    try { setToast(await enablePush(health.vapid_public_key)) } catch (e) { handleErr(e) }
  }

  const c = data?.counts
  const connected = !offline && health?.gmail_connected
  return (
    <div className="app">
      <header className="top">
        <h1>Inbox Agent</h1>
        <div className="status">
          <span className={`dot ${connected ? 'ok' : 'bad'}`} />
          <span>{offline ? 'Backend offline' : connected ? `Gmail connected · ${health?.account}` : 'Gmail needs reconnecting'}</span>
          <span className="sep">·</span>
          <span>Quiet hours: {health?.quiet_now ? 'on' : 'off'}</span>
          <button className="ghost" onClick={pushOn} title="Enable push notifications">🔔 Alerts</button>
          <button className="ghost" onClick={() => setShowSettings(true)}>Settings</button>
        </div>
      </header>

      {health && !health.gmail_connected && !offline && (
        <div className="banner">Gmail access expired (Testing-mode tokens last about 7 days). Reconnect by running
          <code>uv run python -m app.scripts.connect</code> in the backend folder.</div>
      )}
      {health?.backfill && (
        <div className="banner info">Indexing recent mail… {health.backfill.done} / {health.backfill.total}</div>
      )}

      <section className="tiles">
        <Tile n={c?.urgent} label="Urgent" tone="urgent" onClick={() => setTab('urgent')} active={tab === 'urgent'} />
        <Tile n={c?.needs_reply} label="Needs reply" onClick={() => setTab('reply')} active={tab === 'reply'} />
        <Tile n={c?.drafts} label="Drafts waiting" onClick={() => setTab('drafts')} active={tab === 'drafts'} />
        <Tile n={c?.processed_today} label="Processed today" />
      </section>

      <main className="grid">
        <aside className="side">
          <div className="tabs" role="tablist">
            {(['urgent', 'reply', 'drafts'] as Tab[]).map(t => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                {t === 'urgent' ? 'Urgent' : t === 'reply' ? 'Needs reply' : 'Drafts'}
              </button>
            ))}
          </div>

          {tab === 'urgent' && <div className="panel">
            {data?.urgent.length ? data.urgent.map(u => (
              <article key={u.id} className="card">
                <button className="card-main" onClick={() => ask(`Tell me about the ${CATEGORY_LABEL[u.category ?? ''] ?? 'urgent'} email from ${senderName(u.sender)} (thread ${u.thread_id}).`)}>
                  <div className="card-head"><span className={`cat ${u.category ?? ''}`} />{CATEGORY_LABEL[u.category ?? ''] ?? u.category} · {senderName(u.sender)}</div>
                  <p>{u.summary}</p>
                  <small>{u.reason} · {timeAgo(u.received_at)}</small>
                </button>
                <div className="actions">
                  <button onClick={() => feedback(u.id, 'handled')}>Handled</button>
                  <button onClick={() => feedback(u.id, 'not_urgent')}>Not urgent</button>
                  <button onClick={() => feedback(u.id, 'always_alert')}>Always alert</button>
                  <a href={gmailLink(u.thread_id)} target="_blank" rel="noreferrer">Open</a>
                </div>
              </article>
            )) : <p className="empty">Nothing urgent right now.</p>}
          </div>}

          {tab === 'reply' && <div className="panel">
            {data?.needs_reply.length ? data.needs_reply.map(r => (
              <article key={r.thread_id} className="card">
                <div className="card-head">{senderName(r.sender)}</div>
                <p>{r.summary}</p>
                <div className="actions">
                  <small>{timeAgo(r.received_at)}</small>
                  <button onClick={() => setInput(`Draft a reply to ${senderName(r.sender)} (thread ${r.thread_id}) saying `)}>Draft reply</button>
                  <a href={gmailLink(r.thread_id)} target="_blank" rel="noreferrer">Open</a>
                </div>
              </article>
            )) : <p className="empty">No one is waiting on a reply.</p>}
          </div>}

          {tab === 'drafts' && <div className="panel">
            {data?.drafts.length ? data.drafts.map(d => (
              <details key={d.draft_id} className="card">
                <summary><div className="card-head">To {d.to} · {d.subject}</div></summary>
                <p className="draft-body">{d.snippet}</p>
                <div className="actions">
                  <a href="https://mail.google.com/mail/u/0/#drafts" target="_blank" rel="noreferrer">Open in Gmail</a>
                  <button onClick={() => discard(d.draft_id)}>Discard</button>
                </div>
              </details>
            )) : <p className="empty">No drafts waiting. Ask the agent to draft a reply — you send it from Gmail.</p>}
          </div>}
        </aside>

        <section className="chat" aria-label="Chat">
          <div className="thread" ref={threadRef} aria-live="polite">
            {messages.map((m, i) => <div key={i} className={`bubble ${m.role}`}>{m.text}</div>)}
            {toolChip && <div className="chip">{toolChip}</div>}
          </div>
          <form className="composer" onSubmit={send}>
            <input value={input} onChange={e => setInput(e.target.value)} placeholder="Ask about your email…" aria-label="Message" disabled={busy} />
            <button type="submit" aria-label="Send" disabled={busy}>➤</button>
            <button type="button" className={`mic ${voiceState}`} onClick={toggleVoice}
              aria-label={VOICE_LABEL[voiceState]} title={`${VOICE_LABEL[voiceState]} (Space)`}>🎤</button>
          </form>
          <small className="hint">{voiceState === 'idle' ? 'Press Space or tap the mic to talk. The agent drafts — it never sends.' : VOICE_LABEL[voiceState]}</small>
        </section>
      </main>

      {showSettings && <Settings onClose={() => { setShowSettings(false); load() }} onErr={handleErr} onLogout={onLogout} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  )
}

function Tile({ n, label, tone, onClick, active }: { n?: number; label: string; tone?: string; onClick?: () => void; active?: boolean }) {
  const inner = <><strong>{n ?? '–'}</strong><span>{label}</span></>
  return onClick
    ? <button className={`tile ${tone ?? ''} ${active ? 'active' : ''}`} onClick={onClick}>{inner}</button>
    : <div className={`tile ${tone ?? ''}`}>{inner}</div>
}

type SettingsData = { quiet_hours: string | null; vip_senders: string[]; rules: { id: number; pattern: string; action: string }[] }

function Settings({ onClose, onErr, onLogout }: { onClose: () => void; onErr: (e: unknown) => void; onLogout: () => void }) {
  const [s, setS] = useState<SettingsData | null>(null)
  const [quiet, setQuiet] = useState('')
  const [vips, setVips] = useState('')
  const [usage, setUsage] = useState<{ voice_sessions_30d: number; voice_minutes_30d: number } | null>(null)

  const apply = (d: SettingsData) => { setS(d); setQuiet(d.quiet_hours ?? ''); setVips(d.vip_senders.join('\n')) }
  useEffect(() => {
    api<SettingsData>('/api/settings').then(apply).catch(onErr)
    api('/api/usage').then(setUsage).catch(() => {})
  }, [onErr])

  const save = async () => {
    try { apply(await api('/api/settings', { method: 'PUT', json: { quiet_hours: quiet, vip_senders: vips.split(/[\n,]/) } })); onClose() }
    catch (e) { onErr(e) }
  }
  const delRule = async (id: number) => {
    try { await api(`/api/rules/${id}`, { method: 'DELETE' }); apply(await api('/api/settings')) } catch (e) { onErr(e) }
  }
  const logout = async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); onLogout() }

  return (
    <div className="modal" role="dialog" aria-label="Settings" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <h2>Settings</h2>
        <label>Quiet hours (HH:MM-HH:MM; security alerts still come through)
          <input value={quiet} onChange={e => setQuiet(e.target.value)} placeholder="23:00-07:00" />
        </label>
        <label>VIP senders (one email or domain per line)
          <textarea rows={4} value={vips} onChange={e => setVips(e.target.value)} placeholder="boss@company.com" />
        </label>
        {!!s?.rules.length && <>
          <h3>Rules learned from your feedback</h3>
          <ul className="rules">{s.rules.map(r => (
            <li key={r.id}>{r.action === 'always_alert' ? 'Always alert' : r.action === 'never_alert' ? 'Never alert' : r.action}: {r.pattern}
              <button className="ghost" onClick={() => delRule(r.id)}>Remove</button></li>
          ))}</ul>
        </>}
        {usage && <p className="muted">Voice, last 30 days: {usage.voice_sessions_30d} sessions · {usage.voice_minutes_30d} min</p>}
        <div className="actions">
          <button onClick={save}>Save</button>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="ghost" onClick={logout}>Sign out</button>
        </div>
      </div>
    </div>
  )
}
