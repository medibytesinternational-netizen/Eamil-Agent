import { Bell, Bot, LayoutGrid, Mail, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Avatar } from './components/ui'
import { useAgentData } from './hooks/useAgentData'
import { useChat } from './hooks/useChat'
import { api, AuthError, enablePush } from './lib/api'
import { Chat, type ChatHandle } from './screens/Chat'
import { Dashboard } from './screens/Dashboard'

type Page = 'dashboard' | 'agent'

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
    try { await api('/api/login', { json: { password: pw } }); onDone() } catch { setErr('Incorrect password') }
  }
  return (
    <div className="login-page">
      <form className="card login" onSubmit={submit}>
        <span className="logo" aria-hidden><Mail size={26} /></span>
        <h1>Inbox Agent</h1>
        <p>Enter your app password to continue.</p>
        <input type="password" value={pw} onChange={e => setPw(e.target.value)} placeholder="Password" aria-label="Password" autoFocus />
        {err && <span className="err">{err}</span>}
        <button type="submit" className="btn primary wide">Continue</button>
      </form>
    </div>
  )
}

const DOCK: { id: Page; label: string; icon: typeof LayoutGrid }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutGrid },
  { id: 'agent', label: 'Agent', icon: Bot },
]

function Agent({ onLogout }: { onLogout: () => void }) {
  const [page, setPage] = useState<Page>('dashboard')
  const [toast, setToast] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const chatRef = useRef<ChatHandle>(null)

  const onError = useCallback((e: unknown) => {
    if (e instanceof AuthError) onLogout()
    else setToast(e instanceof Error ? e.message : String(e))
  }, [onLogout])
  const data = useAgentData(onLogout, onError)
  const chat = useChat(onError, data.load)

  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(''), 4500); return () => clearTimeout(t) } }, [toast])
  useEffect(() => { window.scrollTo(0, 0) }, [page])

  const ask = (q?: string, prefill = false) => {
    setPage('agent')
    if (!q) return
    if (prefill) setTimeout(() => chatRef.current?.prefill(q), 60)
    else chat.ask(q)
  }
  const pushOn = async () => {
    if (!data.health?.vapid_public_key) return
    try { setToast(await enablePush(data.health.vapid_public_key)) } catch (e) { onError(e) }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(el.tagName)) return
      if (e.code === 'Space' && !e.repeat) { e.preventDefault(); chat.toggleVoice() }
      if (e.key === '/') { e.preventDefault(); setPage('agent'); setTimeout(() => (document.querySelector('[data-chat-input]') as HTMLElement)?.focus(), 60) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [chat.toggleVoice])

  const account = data.health?.account ?? ''
  const name = account.split('@')[0].replace(/[0-9._]+/g, ' ').trim()
  const display = name ? name[0].toUpperCase() + name.slice(1) : 'You'
  const urgent = data.stats?.metrics.urgent.value ?? 0
  const connected = !!data.health?.gmail_connected && !data.offline

  return (
    <div className={`shell on-${page}`}>
      <header className="dock">
        <nav className="dock-nav" aria-label="Pages">
          {DOCK.map(d => (
            <button key={d.id} className={page === d.id ? 'on' : ''} onClick={() => setPage(d.id)} aria-current={page === d.id ? 'page' : undefined}>
              <d.icon size={20} aria-hidden />
              <span className="dock-label">{d.label}</span>
              {d.id === 'dashboard' && urgent > 0 && <span className="count">{urgent}</span>}
            </button>
          ))}
        </nav>
        <div className="dock-right">
          <a className="icon-btn" href="https://mail.google.com" target="_blank" rel="noreferrer" aria-label="Open Gmail"><Mail size={18} /></a>
          <button className="icon-btn" onClick={pushOn} aria-label="Turn on notifications">
            <Bell size={18} />{urgent > 0 && <span className="dot-badge" />}
          </button>
          <button className="profile" onClick={() => setSettingsOpen(true)} aria-label="Account and settings">
            <span className="avatar-wrap"><Avatar name={display} size={40} /><span className={`presence ${connected ? 'ok' : 'bad'}`} /></span>
            <span className="profile-text"><strong>{display}</strong><small>{account}</small></span>
          </button>
        </div>
      </header>

      <main className="main">
        {page === 'dashboard'
          ? <Dashboard data={data} chat={chat} onAsk={ask} onSettings={() => setSettingsOpen(true)} />
          : <Chat ref={chatRef} chat={chat} />}
      </main>

      {settingsOpen && <Settings onClose={() => { setSettingsOpen(false); data.load() }} onErr={onError} onLogout={onLogout} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  )
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
    try { await api('/api/settings', { method: 'PUT', json: { quiet_hours: quiet, vip_senders: vips.split(/[\n,]/) } }); onClose() }
    catch (e) { onErr(e) }
  }
  const delRule = async (id: number) => {
    try { await api(`/api/rules/${id}`, { method: 'DELETE' }); apply(await api('/api/settings')) } catch (e) { onErr(e) }
  }
  const logout = async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); onLogout() }

  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label="Settings" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="card sheet">
        <header className="sheet-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        <label className="field">Quiet hours
          <input value={quiet} onChange={e => setQuiet(e.target.value)} placeholder="23:00-07:00" />
          <small>Security alerts still come through.</small>
        </label>
        <label className="field">VIP senders
          <textarea rows={4} value={vips} onChange={e => setVips(e.target.value)} placeholder="One email or domain per line" />
        </label>
        {!!s?.rules.length && (
          <div className="field">Learned rules
            <ul className="rules">{s.rules.map(r => (
              <li key={r.id}><span>{r.action === 'always_alert' ? 'Always alert' : r.action === 'never_alert' ? 'Never alert' : r.action} · {r.pattern}</span>
                <button className="link-btn" onClick={() => delRule(r.id)}>Remove</button></li>
            ))}</ul>
          </div>
        )}
        {usage && <p className="muted">Voice, last 30 days: {usage.voice_sessions_30d} sessions · {usage.voice_minutes_30d} min</p>}
        <div className="sheet-actions">
          <button className="btn primary" onClick={save}>Save</button>
          <button className="btn outline" onClick={logout}>Sign out</button>
        </div>
      </div>
    </div>
  )
}
