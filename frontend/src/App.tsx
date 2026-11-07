import { X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAgentData } from './hooks/useAgentData'
import { useChat } from './hooks/useChat'
import { api, AuthError, enablePush } from './lib/api'
import { Ask, type AskHandle } from './screens/Ask'
import { Home } from './screens/Home'
import { Insight } from './screens/Insight'

type Screen = 'home' | 'ask' | 'insight'
type Layout = 'phone' | 'tablet' | 'desktop'

function useLayout(): Layout {
  const get = (): Layout => (window.innerWidth >= 1200 ? 'desktop' : window.innerWidth >= 768 ? 'tablet' : 'phone')
  const [l, setL] = useState<Layout>(get)
  useEffect(() => {
    const on = () => setL(get())
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return l
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null)
  useEffect(() => { api('/api/me').then(r => setAuthed(r.logged_in)).catch(() => setAuthed(false)) }, [])
  if (authed === null) return <div className="bg" />
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
    <div className="bg center">
      <form className="login glass" onSubmit={submit}>
        <h1 className="hero"><span className="dim">Welcome to</span> Inbox Agent.</h1>
        <label htmlFor="pw">App password</label>
        <input id="pw" type="password" value={pw} onChange={e => setPw(e.target.value)} autoFocus />
        {err && <p className="err">{err}</p>}
        <button type="submit" className="ask-cta static">Sign in</button>
        <small className="muted">Set APP_PASSWORD in the project's .env file.</small>
      </form>
    </div>
  )
}

function Agent({ onLogout }: { onLogout: () => void }) {
  const layout = useLayout()
  const [screen, setScreen] = useState<Screen>('home')
  const [toast, setToast] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const askRef = useRef<AskHandle>(null)

  const onError = useCallback((e: unknown) => {
    if (e instanceof AuthError) onLogout()
    else setToast(e instanceof Error ? e.message : String(e))
  }, [onLogout])
  const data = useAgentData(onLogout, onError)
  const chat = useChat(onError, data.load)

  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(''), 5000); return () => clearTimeout(t) } }, [toast])

  const goAsk = (q?: string) => { if (layout === 'phone') setScreen('ask'); if (q) chat.ask(q) }
  const draftReply = (text: string) => { if (layout === 'phone') setScreen('ask'); setTimeout(() => askRef.current?.prefill(text), 50) }
  const pushOn = async () => {
    if (!data.health?.vapid_public_key) return
    try { setToast(await enablePush(data.health.vapid_public_key)) } catch (e) { onError(e) }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'SUMMARY'].includes(el.tagName)) return
      if (e.code === 'Space' && !e.repeat) { e.preventDefault(); if (layout === 'phone') setScreen('ask'); chat.toggleVoice() }
      if (e.key === '/') { e.preventDefault(); if (layout === 'phone') setScreen('ask'); setTimeout(() => (document.querySelector('[data-chat-input]') as HTMLInputElement)?.focus(), 50) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [layout, chat.toggleVoice])

  const home = <Home data={data} onAsk={goAsk} onOpenInsight={() => setScreen('insight')} onSettings={() => setSettingsOpen(true)}
    onPush={pushOn} onDraftReply={draftReply} />
  const ask = <Ask ref={askRef} chat={chat} onBack={layout === 'phone' ? () => setScreen('home') : undefined} />
  const insight = <Insight insight={data.insight} onAsk={q => { if (layout !== 'desktop') setScreen(layout === 'phone' ? 'ask' : 'home'); chat.ask(q) }}
    onBack={layout === 'desktop' ? undefined : () => setScreen('home')} onRefresh={() => data.loadInsight(true)} />

  return (
    <div className={`bg layout-${layout}`}>
      {layout === 'phone' && <main className="phone" key={screen}>{screen === 'home' ? home : screen === 'ask' ? ask : insight}</main>}
      {layout === 'tablet' && (
        <main className="columns two">
          <section className="col">{home}</section>
          <section className="col">{ask}</section>
          {screen === 'insight' && <div className="overlay" onClick={e => e.target === e.currentTarget && setScreen('home')}><section className="col">{insight}</section></div>}
        </main>
      )}
      {layout === 'desktop' && (
        <main className="columns three">
          <section className="col">{home}</section>
          <section className="col">{ask}</section>
          <section className="col">{insight}</section>
        </main>
      )}
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
    try { apply(await api('/api/settings', { method: 'PUT', json: { quiet_hours: quiet, vip_senders: vips.split(/[\n,]/) } })); onClose() }
    catch (e) { onErr(e) }
  }
  const delRule = async (id: number) => {
    try { await api(`/api/rules/${id}`, { method: 'DELETE' }); apply(await api('/api/settings')) } catch (e) { onErr(e) }
  }
  const logout = async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); onLogout() }

  return (
    <div className="overlay sheet-wrap" role="dialog" aria-label="Settings" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="sheet glass">
        <div className="sheet-head"><h2>Settings</h2><button className="round-btn" onClick={onClose} aria-label="Close"><X size={16} /></button></div>
        <label>Quiet hours (HH:MM-HH:MM — security alerts still come through)
          <input value={quiet} onChange={e => setQuiet(e.target.value)} placeholder="23:00-07:00" />
        </label>
        <label>VIP senders (one email or domain per line)
          <textarea rows={4} value={vips} onChange={e => setVips(e.target.value)} placeholder="boss@company.com" />
        </label>
        {!!s?.rules.length && <>
          <h3 className="section-title">Rules learned from your feedback</h3>
          <ul className="rules">{s.rules.map(r => (
            <li key={r.id}><span>{r.action === 'always_alert' ? 'Always alert' : r.action === 'never_alert' ? 'Never alert' : r.action}: {r.pattern}</span>
              <button className="link" onClick={() => delRule(r.id)}>Remove</button></li>
          ))}</ul>
        </>}
        {usage && <p className="muted">Voice, last 30 days: {usage.voice_sessions_30d} sessions · {usage.voice_minutes_30d} min</p>}
        <div className="sheet-actions">
          <button className="ask-cta static" onClick={save}>Save</button>
          <button className="pill" onClick={logout}>Sign out</button>
        </div>
      </div>
    </div>
  )
}
