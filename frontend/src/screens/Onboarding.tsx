import { BotAvatar } from 'bot-avatars'
import { AlertTriangle, ArrowLeft, ArrowRight, Check, Loader2, Mail, ShieldCheck, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../lib/api'

export type Profile = {
  user_name: string; user_email: string; agent_name: string
  urgent_criteria: string; important_criteria: string
  urgent_senders: string[]; important_senders: string[]; onboarded?: boolean
}
type Progress = { done: number; total: number; finished?: boolean; failed?: boolean }
type Summary = { total: number; urgent: number; important: number }
type Estimate = { days: number; total: number; ai_review: number; limit: number }
type ConnectResult = {
  ok: boolean; error?: string; account?: string; returning?: boolean; onboarded?: boolean
  typed_email?: string; mismatch?: boolean
}

const STEPS = ['About you', 'Your agent', 'What matters', 'Connect Gmail', 'Getting ready']
const EMPTY: Profile = { user_name: '', user_email: '', agent_name: 'Inbox Agent', urgent_criteria: '', important_criteria: '', urgent_senders: [], important_senders: [] }
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const RESUME_KEY = 'onboarding-step'

function SenderChips({ label, value, onChange }: { label: string; value: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const v = draft.trim().toLowerCase()
    if (v && !value.includes(v)) onChange([...value, v])
    setDraft('')
  }
  return (
    <div className="ob-chips">
      <span className="ob-chips-label">{label}</span>
      <div className="ob-chip-row">
        {value.map(v => (
          <span key={v} className="ob-chip">{v}
            <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter(x => x !== v))}><X size={12} /></button>
          </span>
        ))}
        <input value={draft} onChange={e => setDraft(e.target.value)} placeholder="name@company.com or company.com"
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() } }} onBlur={add} aria-label={label} />
      </div>
    </div>
  )
}

export function Onboarding({ initial, oauthMode, resumeConnect, onDone }: {
  initial: Profile | null; oauthMode: 'web' | 'desktop'; resumeConnect?: boolean; onDone: (p: Profile) => void
}) {
  const [step, setStep] = useState(() => {
    try { const s = Number(sessionStorage.getItem(RESUME_KEY)); if (s >= 0 && s < STEPS.length && s > 0) return s } catch { /* ignore */ }
    return resumeConnect ? 3 : 0
  })
  const [p, setP] = useState<Profile>({ ...EMPTY, ...(initial ?? {}) })
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  const [connected, setConnected] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [mismatch, setMismatch] = useState<ConnectResult | null>(null)
  const [estimate, setEstimate] = useState<Estimate | null>(null)
  const [started, setStarted] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const set = (k: keyof Profile) => (v: string | string[]) => setP(x => ({ ...x, [k]: v }))

  useEffect(() => { try { sessionStorage.setItem(RESUME_KEY, String(step)) } catch { /* ignore */ } }, [step])

  // Pre-fill the rule text with suggestions the first time.
  useEffect(() => {
    if (initial?.urgent_criteria || initial?.important_criteria) return
    api<{ urgent_criteria: string; important_criteria: string }>('/api/onboarding/suggestions')
      .then(s => setP(x => ({ ...x, urgent_criteria: x.urgent_criteria || s.urgent_criteria, important_criteria: x.important_criteria || s.important_criteria })))
      .catch(() => { /* fields stay editable */ })
  }, [initial])

  const handleResult = (r: ConnectResult) => {
    if (!r.ok) { setErr(r.error || 'Google sign-in failed'); return }
    if (r.returning && r.onboarded) {
      // A Gmail account this device already knows: its own rules and history come back.
      try { sessionStorage.removeItem(RESUME_KEY) } catch { /* ignore */ }
      window.location.assign('/')
      return
    }
    setConnected(r.account ?? null)
    setMismatch(r.mismatch ? r : null)
  }

  // Back from Google (hosted / web sign-in): /?connect=ok|error
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('connect')
    if (!q) {
      api<{ gmail_connected: boolean; account: string }>('/api/health')
        .then(h => { if (h.gmail_connected) setConnected(h.account) }).catch(() => {})
      return
    }
    window.history.replaceState(null, '', '/')
    setStep(3)
    api<ConnectResult>('/api/oauth/result').then(handleResult).catch(e => setErr(e instanceof Error ? e.message : 'Sign-in failed'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Last step: estimate cost first, then show progress over SSE.
  useEffect(() => {
    if (step !== 4) return
    api<Estimate>('/api/onboarding/estimate?days=14').then(setEstimate).catch(() => setEstimate(null))
    const loadSummary = () => api<Summary>('/api/onboarding/summary').then(setSummary).catch(() => {})
    const es = new EventSource('/api/events')
    es.addEventListener('backfill', e => {
      try {
        const d = JSON.parse((e as MessageEvent).data || '{}') as Progress
        setProgress(d)
        if (d.finished || d.failed) loadSummary()
      } catch { /* ignore malformed */ }
    })
    loadSummary()
    return () => es.close()
  }, [step])

  const valid = [
    p.user_name.trim().length > 0 && EMAIL_RE.test(p.user_email.trim()),
    p.agent_name.trim().length > 0,
    true,
    !!connected && !mismatch,
    true,
  ]

  const saveProfile = async (profile = p) => {
    setSaving(true); setErr('')
    try { await api('/api/onboarding/profile', { method: 'PUT', json: profile }); return true }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not save'); return false }
    finally { setSaving(false) }
  }

  const next = async () => {
    if (!valid[step]) return
    if (step <= 2 && !(await saveProfile())) return
    setStep(s => Math.min(s + 1, STEPS.length - 1))
  }

  const connect = async () => {
    setErr(''); setMismatch(null)
    if (oauthMode === 'web') { window.location.assign('/api/oauth/start'); return }
    setConnecting(true)
    try { handleResult(await api<ConnectResult>('/api/onboarding/connect', { method: 'POST' })) }
    catch (e) { setErr(e instanceof Error ? e.message : 'Google sign-in failed') }
    finally { setConnecting(false) }
  }

  const useSignedIn = async () => {
    if (!mismatch?.account) return
    const updated = { ...p, user_email: mismatch.account }
    if (await saveProfile(updated)) { setP(updated); setMismatch(null) }
  }
  const tryAgain = async () => {
    await api('/api/account/disconnect', { method: 'POST' }).catch(() => {})
    setConnected(null); setMismatch(null)
    await saveProfile()  // the profile goes back into the fresh pending store
    connect()
  }

  const startBackfill = async (days: number) => {
    setErr('')
    try { await api('/api/onboarding/backfill', { json: { days } }); setStarted(true) }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not start') }
  }

  const finish = async () => {
    try {
      const r = await api<Profile>('/api/onboarding/finish', { method: 'POST' })
      try { sessionStorage.removeItem(RESUME_KEY) } catch { /* ignore */ }
      onDone(r)
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not finish') }
  }

  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : progress?.finished ? 100 : 0
  const done = !!progress?.finished
  const running = started && !done

  return (
    <div className="ob-page">
      <div className="ob-card card">
        <ol className="ob-steps" aria-label="Setup progress">
          {STEPS.map((s, i) => (
            <li key={s} className={i === step ? 'on' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}>
              <span className="ob-dot">{i < step ? <Check size={12} /> : i + 1}</span><span className="ob-step-label">{s}</span>
            </li>
          ))}
        </ol>

        {step === 0 && (
          <section className="ob-body">
            <h1>Welcome — let's set up your agent</h1>
            <p className="muted">It takes about a minute. Your data stays in this app's own database — never another cloud.</p>
            <label className="ob-field">Your name
              <input value={p.user_name} onChange={e => set('user_name')(e.target.value)} placeholder="e.g. Asha" autoFocus maxLength={80} />
            </label>
            <label className="ob-field">Your Gmail address
              <input type="email" value={p.user_email} onChange={e => set('user_email')(e.target.value)} placeholder="you@gmail.com" maxLength={200} />
            </label>
          </section>
        )}

        {step === 1 && (
          <section className="ob-body">
            <h1>Name your agent</h1>
            <div className="ob-agent">
              <BotAvatar type="flower" size={84} aria-hidden />
              <div className="ob-hello">Hi {p.user_name || 'there'}, I'm <strong>{p.agent_name || '…'}</strong>. I'll watch your inbox and tell you what needs you.</div>
            </div>
            <label className="ob-field">Agent name
              <input value={p.agent_name} onChange={e => set('agent_name')(e.target.value)} placeholder="e.g. Juno" autoFocus maxLength={40} />
            </label>
          </section>
        )}

        {step === 2 && (
          <section className="ob-body">
            <h1>What matters to you?</h1>
            <p className="muted">Write it in your own words. {p.agent_name} uses this to flag every email. You can change it later in Settings.</p>
            <label className="ob-field"><span><span className="ob-badge urgent">Urgent</span> needs an immediate reply</span>
              <textarea rows={3} value={p.urgent_criteria} onChange={e => set('urgent_criteria')(e.target.value)} maxLength={2000} />
            </label>
            <SenderChips label="Always urgent from" value={p.urgent_senders} onChange={set('urgent_senders')} />
            <label className="ob-field"><span><span className="ob-badge important">Important</span> must read, even if no reply</span>
              <textarea rows={3} value={p.important_criteria} onChange={e => set('important_criteria')(e.target.value)} maxLength={2000} />
            </label>
            <SenderChips label="Always important from" value={p.important_senders} onChange={set('important_senders')} />
          </section>
        )}

        {step === 3 && (
          <section className="ob-body">
            <h1>{resumeConnect ? 'Reconnect Gmail' : 'Connect Gmail'}</h1>
            <p className="muted">{oauthMode === 'web' ? 'You\'ll be taken to Google' : 'A Google window will open'}. Sign in as <strong>{p.user_email || 'your account'}</strong> and allow access.</p>
            <ul className="ob-safe">
              <li><ShieldCheck size={16} /> Reads mail and saves drafts only — it can never send email.</li>
              <li><ShieldCheck size={16} /> Each Gmail account gets its own separate database. Your sign-in token is stored encrypted.</li>
            </ul>
            {mismatch ? (
              <div className="ob-warn" role="alert">
                <AlertTriangle size={18} />
                <div>
                  <strong>You signed in as {mismatch.account}</strong>, not {mismatch.typed_email}.
                  <div className="ob-warn-actions">
                    <button className="btn primary sm" onClick={useSignedIn}>Use {mismatch.account}</button>
                    <button className="btn outline sm" onClick={tryAgain}>Sign in as {mismatch.typed_email}</button>
                  </div>
                </div>
              </div>
            ) : connected
              ? <div className="ob-ok"><Check size={18} /> Connected as {connected}</div>
              : <button className="btn primary wide" onClick={connect} disabled={connecting}>
                  {connecting ? <><Loader2 size={16} className="spin" /> Waiting for Google…</> : <><Mail size={16} /> Connect Gmail</>}
                </button>}
          </section>
        )}

        {step === 4 && (
          <section className="ob-body">
            <h1>{done ? `${p.agent_name} is ready` : running ? `${p.agent_name} is reading your inbox` : 'How much history should I read?'}</h1>
            {!started && (
              <>
                <p className="muted">Reading recent mail gives {p.agent_name} context from day one. Old mail never triggers notifications.</p>
                {estimate ? (
                  <div className="ob-choice">
                    <button className="ob-option" onClick={() => startBackfill(14)}>
                      <strong>Last 2 weeks</strong>
                      <span>{estimate.total} emails · about {estimate.ai_review} need an AI read</span>
                    </button>
                    <button className="ob-option" onClick={() => startBackfill(7)}>
                      <strong>Last week only</strong>
                      <span>Roughly half the cost</span>
                    </button>
                  </div>
                ) : <span className="muted"><Loader2 size={14} className="spin" /> Counting emails…</span>}
                <small className="muted">Promotions, social and newsletters are sorted by free rules. Only the rest uses AI. Capped at {estimate?.limit ?? 300} emails.</small>
              </>
            )}
            {running && (
              <div className="ob-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div className="ob-bar"><span style={{ width: `${pct}%` }} /></div>
                <span className="muted">{progress?.total ? `Processed ${progress.done} of ${progress.total} emails (unread first)` : 'Finding emails…'}</span>
              </div>
            )}
            {progress?.failed && <div className="ob-err">Processing stopped early — it will continue in the background.</div>}
            {(done || (started && summary && summary.total > 0)) && summary && (
              <div className="ob-summary">
                <div><strong>{summary.total}</strong><span>emails read</span></div>
                <div className="urgent"><strong>{summary.urgent}</strong><span>urgent</span></div>
                <div className="important"><strong>{summary.important}</strong><span>important</span></div>
              </div>
            )}
          </section>
        )}

        {err && <div className="ob-err" role="alert">{err}</div>}

        <div className="ob-nav">
          {step > 0 && step < 4 && !(resumeConnect && step === 3)
            ? <button className="btn outline" onClick={() => setStep(s => s - 1)}><ArrowLeft size={16} /> Back</button>
            : <span />}
          {step < 4
            ? <button className="btn primary" onClick={next} disabled={!valid[step] || saving}>
                {step === 3 ? 'Continue' : 'Next'} <ArrowRight size={16} />
              </button>
            : <button className="btn primary" onClick={finish} disabled={!started && !resumeConnect}>
                {done || resumeConnect ? 'Go to dashboard' : 'Continue in background'} <ArrowRight size={16} />
              </button>}
        </div>
      </div>
    </div>
  )
}
