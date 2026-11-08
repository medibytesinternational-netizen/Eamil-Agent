import { Bell, Bot, LayoutGrid, Mail, Moon, Sun, X } from 'lucide-react'
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


const NAV: { id: Page; label: string; icon: typeof LayoutGrid }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutGrid },
  { id: 'agent', label: 'Agent', icon: Bot },
]

type Theme = 'light' | 'dark'
function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try { const t = localStorage.getItem('theme'); if (t === 'light' || t === 'dark') return t } catch { /* storage blocked */ }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#050706' : '#eceeec')
    try { localStorage.setItem('theme', theme) } catch { /* ignore */ }
  }, [theme])
  return [theme, () => setTheme(t => (t === 'dark' ? 'light' : 'dark'))]
}

function Agent({ onLogout }: { onLogout: () => void }) {
  const [page, setPage] = useState<Page>('dashboard')
  const [toast, setToast] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [theme, toggleTheme] = useTheme()
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
  const busy = chat.busy || chat.voiceState !== 'idle'

  return (
    <div className={`shell on-${page}`}>
      <header className="pillnav-wrap">
        <nav className="pillnav" aria-label="Main">
          <div className="pn-group">
            {NAV.map(n => (
              <button key={n.id} className={`pn-tab ${page === n.id ? 'on' : ''}`} onClick={() => setPage(n.id)}
                aria-current={page === n.id ? 'page' : undefined} title={n.label}>
                <n.icon size={17} aria-hidden /><span className="pn-label">{n.label}</span>
                {n.id === 'dashboard' && urgent > 0 && <span className="pn-count">{urgent}</span>}
              </button>
            ))}
          </div>
          <span className="pn-brand" title={busy ? 'Agent is working' : 'Agent is online'}>
            <span className={`pn-dot ${busy ? 'busy' : connected ? 'ok' : 'bad'}`} aria-hidden />Inbox Agent
          </span>
          <div className="pn-group">
            <a className="pn-icon" href="https://mail.google.com" target="_blank" rel="noreferrer" aria-label="Open Gmail" title="Open Gmail"><Mail size={17} /></a>
            <button className="pn-icon" onClick={toggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} title="Toggle theme">
              {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
            </button>
            <button className="pn-profile" onClick={() => setSettingsOpen(true)} aria-label={`${display} — account and settings`} title={account}>
              <Avatar name={display} size={30} /><span className={`presence ${connected ? 'ok' : 'bad'}`} />
            </button>
          </div>
        </nav>
      </header>

      <main className="main">
        {page === 'dashboard'
          ? <Dashboard data={data} chat={chat} onAsk={ask} onSettings={() => setSettingsOpen(true)} />
          : <Chat ref={chatRef} chat={chat} name={display} />}
      </main>

      {settingsOpen && <Settings account={account} display={display} onPush={pushOn}
        onClose={() => { setSettingsOpen(false); data.load() }} onErr={onError} onLogout={onLogout} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  )
}

type SettingsData = { quiet_hours: string | null; vip_senders: string[]; rules: { id: number; pattern: string; action: string }[] }

function Settings({ account, display, onPush, onClose, onErr, onLogout }: {
  account: string; display: string; onPush: () => void; onClose: () => void; onErr: (e: unknown) => void; onLogout: () => void
}) {
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
        <div className="settings-profile">
          <Avatar name={display} size={46} />
          <span><strong>{display}</strong><small>{account}</small></span>
        </div>
        <button className="btn outline wide" onClick={onPush}><Bell size={16} /> Turn on notifications</button>
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
