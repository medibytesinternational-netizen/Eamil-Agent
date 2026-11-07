import {
  AlertTriangle, ExternalLink, Inbox, Megaphone, Mic, Plus, Reply, Settings, ShieldAlert, Sparkles, Square, Tag, User, Wallet,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { ArrowBtn, Avatar, Gauge, IconTile, PillChart, Segmented, Skeleton } from '../components/ui'
import type { useAgentData } from '../hooks/useAgentData'
import type { useChat } from '../hooks/useChat'

type Data = ReturnType<typeof useAgentData>

const CAT: Record<string, [LucideIcon, string, string]> = {
  payment: [Wallet, 'orange', 'Payment due'], security: [ShieldAlert, 'red', 'Security'],
  reply_needed: [Reply, 'blue', 'Reply needed'], deadline: [AlertTriangle, 'orange', 'Deadline'],
  newsletter: [Megaphone, 'purple', 'Newsletters'], promo: [Tag, 'pink', 'Promotions'],
  personal: [User, 'green', 'Personal'], otp: [ShieldAlert, 'gray', 'One-time codes'], other: [Inbox, 'teal', 'Other'],
}
const cat = (c: string | null) => CAT[c ?? ''] ?? CAT.other
const IMPORTANT = new Set(['payment', 'security', 'reply_needed', 'deadline'])
const NOISE = new Set(['newsletter', 'promo', 'otp'])

export const senderName = (s: string) => s.replace(/<.*>/, '').replace(/"/g, '').trim() || s
const gmailLink = (t: string) => `https://mail.google.com/mail/u/0/#all/${t}`

function timeAgo(iso: string) {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  if (m < 60) return `${m}m ago`
  if (m < 1440) return `${Math.round(m / 60)}h ago`
  return `${Math.round(m / 1440)}d ago`
}

function changeText(change: number | null | undefined, period: string) {
  if (change === null || change === undefined) return 'No earlier data yet'
  if (change === 0) return `Same as last ${period}`
  return `${change > 0 ? 'Up' : 'Down'} ${Math.abs(change)}% from last ${period}`
}

function useTimer(running: boolean) {
  const [secs, setSecs] = useState(0)
  useEffect(() => {
    if (!running) { setSecs(0); return }
    const t = setInterval(() => setSecs(s => s + 1), 1000)
    return () => clearInterval(t)
  }, [running])
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(Math.floor(secs / 3600))}:${p(Math.floor(secs / 60) % 60)}:${p(secs % 60)}`
}

export function Dashboard({ data, chat, onAsk, onSettings }: {
  data: Data; chat: ReturnType<typeof useChat>; onAsk: (q?: string, prefill?: boolean) => void; onSettings: () => void
}) {
  const { health, dash, stats, insight, range, setRange, offline, feedback, discard } = data
  const m = stats?.metrics
  const period = range === 'today' ? 'day' : 'week'
  const voiceOn = chat.voiceState !== 'idle'
  const timer = useTimer(voiceOn)

  const cats = stats?.categories ?? []
  const important = cats.filter(c => IMPORTANT.has(c.category)).reduce((s, c) => s + c.count, 0)
  const noise = cats.filter(c => NOISE.has(c.category)).reduce((s, c) => s + c.count, 0)
  const rest = cats.reduce((s, c) => s + c.count, 0) - important - noise
  const totalCats = important + noise + rest
  const noisePct = totalCats ? Math.round((noise / totalCats) * 100) : 0

  const people = [
    ...(dash?.urgent ?? []).map(u => ({ key: `u${u.id}`, sender: u.sender, text: u.summary, status: 'Urgent', tone: 'red', thread: u.thread_id })),
    ...(dash?.needs_reply ?? []).map(r => ({ key: `r${r.thread_id}`, sender: r.sender, text: r.summary, status: 'Needs reply', tone: 'amber', thread: r.thread_id })),
    ...(dash?.drafts ?? []).map(d => ({ key: `d${d.draft_id}`, sender: d.to ?? 'Draft', text: d.subject, status: 'Draft', tone: 'green', thread: d.thread_id ?? '' })),
  ].slice(0, 5)

  const stat = [
    { label: 'Urgent', value: m?.urgent.value, note: changeText(m?.urgent.change, period), q: 'What is urgent right now?' },
    { label: 'Needs Reply', value: m?.needs_reply.value, note: changeText(m?.needs_reply.change, period), q: "Who's waiting on my reply?" },
    { label: 'Drafts', value: m?.drafts.value, note: 'Waiting for your review', q: 'Which drafts are waiting for me?' },
    { label: 'Processed', value: m?.processed.value, note: changeText(m?.processed.change, period), q: 'Give me a quick briefing of my inbox.' },
  ]

  return (
    <div className="dash">
      <div className="dash-head">
        <div>
          <h1>Dashboard</h1>
          <p>Triage, search and draft — your inbox, handled.</p>
        </div>
        <div className="head-actions">
          <Segmented label="Range" value={range} onChange={setRange} options={[{ value: 'today', label: 'Today' }, { value: '7d', label: 'Week' }]} />
          <button className="btn primary" onClick={() => onAsk()}><Plus size={16} /> Ask Agent</button>
          <button className="btn outline" onClick={onSettings}><Settings size={16} /> Settings</button>
        </div>
      </div>

      {health && !health.gmail_connected && !offline && (
        <div className="notice red">Gmail access expired. Run <code>uv run python -m app.scripts.connect</code> in the backend folder.</div>
      )}
      {offline && <div className="notice red">Can't reach the backend. Is it running on port 8010?</div>}
      {health?.backfill && <div className="notice">Indexing recent mail… {health.backfill.done} of {health.backfill.total}</div>}

      <div className="bento">
        {stat.map((s, i) => (
          <div key={s.label} className={`card stat ${i === 0 ? 'hero' : ''}`}>
            <div className="stat-top"><span>{s.label}</span><ArrowBtn light={i === 0} label={`Ask about ${s.label}`} onClick={() => onAsk(s.q)} /></div>
            <strong>{s.value ?? '–'}</strong>
            <small>{s.note}</small>
          </div>
        ))}

        <div className="card analytics">
          <div className="card-head"><h2>Inbox Analytics</h2><span className="muted">{stats?.week_total ?? '–'} this week</span></div>
          {stats ? <PillChart data={stats.daily} /> : <Skeleton lines={4} />}
        </div>

        <div className="card reminder">
          <h2>AI Summary</h2>
          {insight ? <p className="reminder-title">{insight.headline}</p> : <Skeleton lines={2} />}
          <p className="muted">{insight?.brief}</p>
          <button className="btn primary wide" onClick={() => onAsk('Give me a quick briefing of my inbox.')}><Sparkles size={16} /> Get Briefing</button>
        </div>

        <div className="card attention">
          <div className="card-head"><h2>Needs Attention</h2><button className="btn outline sm" onClick={() => onAsk('What is urgent right now?')}><Plus size={14} /> Ask</button></div>
          <ul className="list">
            {(dash?.urgent ?? []).map(u => {
              const [icon, tone, label] = cat(u.category)
              return (
                <li key={u.id}>
                  <IconTile icon={icon} tone={tone} />
                  <div className="list-text">
                    <button className="list-title" onClick={() => onAsk(`Tell me about the ${label.toLowerCase()} email from ${senderName(u.sender)} (thread ${u.thread_id}).`)}>{senderName(u.sender)} · {label}</button>
                    <small>{timeAgo(u.received_at)}</small>
                    <div className="mini-actions">
                      <button onClick={() => feedback(u.id, 'handled')}>Done</button>
                      <button onClick={() => feedback(u.id, 'not_urgent')}>Not urgent</button>
                      <button onClick={() => feedback(u.id, 'always_alert')}>Always alert</button>
                      <a href={gmailLink(u.thread_id)} target="_blank" rel="noreferrer" aria-label="Open in Gmail"><ExternalLink size={13} /></a>
                    </div>
                  </div>
                </li>
              )
            })}
            {cats.filter(c => !IMPORTANT.has(c.category)).slice(0, 4).map(c => {
              const [icon, tone, label] = cat(c.category)
              return (
                <li key={c.category}>
                  <IconTile icon={icon} tone={tone} />
                  <div className="list-text">
                    <button className="list-title" onClick={() => onAsk(`Summarise my ${label.toLowerCase()} emails from this week.`)}>{label}</button>
                    <small>{c.count} this week</small>
                  </div>
                </li>
              )
            })}
            {!stats && <li><Skeleton lines={3} /></li>}
          </ul>
        </div>

        <div className="card people">
          <div className="card-head"><h2>People & Drafts</h2><button className="btn outline sm" onClick={() => onAsk('Draft a reply to ', true)}><Plus size={14} /> Draft</button></div>
          <ul className="list">
            {people.map(p => (
              <li key={p.key}>
                <Avatar name={p.sender} />
                <div className="list-text">
                  <span className="list-title static">{senderName(p.sender)}</span>
                  <small className="clamp">{p.text}</small>
                </div>
                {p.status === 'Draft'
                  ? <button className={`status ${p.tone}`} onClick={() => discard(p.key.slice(1))} title="Discard draft">Draft ×</button>
                  : p.status === 'Needs reply'
                    ? <button className={`status ${p.tone}`} onClick={() => onAsk(`Draft a reply to ${senderName(p.sender)} (thread ${p.thread}) saying `, true)}>Reply</button>
                    : <span className={`status ${p.tone}`}>{p.status}</span>}
              </li>
            ))}
            {dash && !people.length && <li className="empty">You're all caught up — no one is waiting.</li>}
            {!dash && <li><Skeleton lines={3} /></li>}
          </ul>
        </div>

        <div className="card progress">
          <h2>Inbox Mix</h2>
          <Gauge center={`${noisePct}%`} caption="Noise filtered"
            segments={[{ value: important, className: 'seg-dark' }, { value: rest, className: 'seg-mid' }, { value: noise, className: 'seg-hatch' }]} />
          <div className="legend">
            <span><i className="seg-dark" /> Important</span>
            <span><i className="seg-mid" /> Other</span>
            <span><i className="seg-hatch" /> Newsletters & promo</span>
          </div>
        </div>

        <div className={`card voice ${voiceOn ? 'on' : ''}`}>
          <h2>Voice Agent</h2>
          <strong className="clock">{timer}</strong>
          <span className="voice-state">{voiceOn ? chat.voiceState : 'Tap to talk to your inbox'}</span>
          <div className="voice-actions">
            <button className="round light" onClick={chat.toggleVoice} aria-label={voiceOn ? 'Stop voice' : 'Start voice'}>
              {voiceOn ? <Square size={18} fill="currentColor" /> : <Mic size={20} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
