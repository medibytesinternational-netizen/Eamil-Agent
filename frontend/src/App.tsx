import { LayoutGrid, Mail, MessageCircle, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAgentData } from './hooks/useAgentData'
import { useChat } from './hooks/useChat'
import { api, AuthError, enablePush } from './lib/api'
import { Chat, type ChatHandle } from './screens/Chat'
import { Dashboard } from './screens/Dashboard'

type Page = 'dashboard' | 'chat'

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
      <form className="login" onSubmit={submit}>
        <span className="app-icon" aria-hidden><Mail size={30} /></span>
        <h1>Inbox Agent</h1>
        <p>Enter your app password to continue.</p>
        <input type="password" value={pw} onChange={e => setPw(e.target.value)} placeholder="Password" aria-label="Password" autoFocus />
        {err && <span className="err">{err}</span>}
        <button type="submit" className="btn-primary">Continue</button>
      </form>
    </div>
  )
}

const TABS: { id: Page; label: string; icon: typeof LayoutGrid }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutGrid },
  { id: 'chat', label: 'Chat', icon: MessageCircle },
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
    setPage('chat')
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
      if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'SUMMARY', 'A'].includes(el.tagName)) return
      if (e.code === 'Space' && !e.repeat) { e.preventDefault(); setPage('chat'); chat.toggleVoice() }
      if (e.key === '/') { e.preventDefault(); setPage('chat'); setTimeout(() => (document.querySelector('[data-chat-input]') as HTMLElement)?.focus(), 60) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [chat.toggleVoice])

  const urgent = data.stats?.metrics.urgent.value ?? 0

  return (
    <div className={`shell on-${page}`}>
      <aside className="sidebar">
        <div className="brand"><span className="app-icon sm" aria-hidden><Mail size={16} /></span>Inbox Agent</div>
        <nav aria-label="Pages">
          {TABS.map(t => (
            <button key={t.id} className={`side-item ${page === t.id ? 'on' : ''}`} onClick={() => setPage(t.id)} aria-current={page === t.id ? 'page' : undefined}>
              <t.icon size={18} aria-hidden />{t.label}
              {t.id === 'dashboard' && urgent > 0 && <span className="badge">{urgent}</span>}
            </button>
          ))}
        </nav>
        <div className="side-foot">
          <span className={`dot ${data.health?.gmail_connected && !data.offline ? 'ok' : 'bad'}`} />
          <span>{data.health?.account ?? 'Connecting…'}</span>
        </div>
      </aside>

      <main className="content">
        {page === 'dashboard'
          ? <Dashboard data={data} onAsk={ask} onSettings={() => setSettingsOpen(true)} onPush={pushOn} />
          : <Chat ref={chatRef} chat={chat} />}
      </main>

      <nav className="tabbar" aria-label="Pages">
        {TABS.map(t => (
          <button key={t.id} className={page === t.id ? 'on' : ''} onClick={() => setPage(t.id)} aria-current={page === t.id ? 'page' : undefined}>
            <span className="tab-icon"><t.icon size={22} aria-hidden />{t.id === 'dashboard' && urgent > 0 && <span className="badge">{urgent}</span>}</span>
            {t.label}
          </button>
        ))}
      </nav>

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
      <div className="sheet">
        <div className="grabber" aria-hidden />
        <header className="sheet-bar">
          <button className="text-btn" onClick={onClose}>Cancel</button>
          <strong>Settings</strong>
          <button className="text-btn bold" onClick={save}>Done</button>
        </header>

        <p className="group-label">Notifications</p>
        <div className="group">
          <label className="cell field">Quiet hours
            <input value={quiet} onChange={e => setQuiet(e.target.value)} placeholder="23:00-07:00" />
          </label>
        </div>
        <p className="group-note">Security alerts still come through during quiet hours.</p>

        <p className="group-label">VIP senders</p>
        <div className="group">
          <textarea className="cell" rows={4} value={vips} onChange={e => setVips(e.target.value)} placeholder="One email or domain per line" aria-label="VIP senders" />
        </div>

        {!!s?.rules.length && <>
          <p className="group-label">Learned rules</p>
          <div className="group">
            {s.rules.map(r => (
              <div key={r.id} className="cell row-between">
                <span>{r.action === 'always_alert' ? 'Always alert' : r.action === 'never_alert' ? 'Never alert' : r.action} · {r.pattern}</span>
                <button className="text-btn destructive" onClick={() => delRule(r.id)}>Remove</button>
              </div>
            ))}
          </div>
        </>}

        {usage && <>
          <p className="group-label">Voice usage (30 days)</p>
          <div className="group">
            <div className="cell row-between"><span>Sessions</span><span className="muted">{usage.voice_sessions_30d}</span></div>
            <div className="cell row-between"><span>Minutes</span><span className="muted">{usage.voice_minutes_30d}</span></div>
          </div>
        </>}

        <div className="group">
          <button className="cell text-btn destructive center" onClick={logout}>Sign Out</button>
        </div>
        <button className="sheet-close" onClick={onClose} aria-label="Close"><X size={16} /></button>
      </div>
    </div>
  )
}
