import {
  AlertTriangle, ChevronRight, CircleCheck, ExternalLink, FileText, Inbox, Megaphone, MessageCircle, Reply,
  Settings, ShieldAlert, Sparkles, Tag, User, Wallet, type LucideIcon,
} from 'lucide-react'
import { IconTile, BarChart, Segmented, Skeleton, Trend } from '../components/ui'
import type { useAgentData } from '../hooks/useAgentData'

type Data = ReturnType<typeof useAgentData>

const CAT: Record<string, [LucideIcon, string, string]> = {
  payment: [Wallet, 'red', 'Payment due'], security: [ShieldAlert, 'red', 'Security'],
  reply_needed: [Reply, 'orange', 'Reply needed'], deadline: [AlertTriangle, 'orange', 'Deadline'],
  newsletter: [Megaphone, 'indigo', 'Newsletters'], promo: [Tag, 'purple', 'Promotions'],
  personal: [User, 'green', 'Personal'], otp: [ShieldAlert, 'gray', 'One-time codes'], other: [Inbox, 'gray', 'Other'],
}
const cat = (c: string | null) => CAT[c ?? ''] ?? CAT.other

export const senderName = (s: string) => s.replace(/<.*>/, '').replace(/"/g, '').trim() || s
const gmailLink = (t: string) => `https://mail.google.com/mail/u/0/#all/${t}`

function timeAgo(iso: string) {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  if (m < 60) return `${m}m`
  if (m < 1440) return `${Math.round(m / 60)}h`
  return `${Math.round(m / 1440)}d`
}

function greeting() {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

export function Dashboard({ data, onAsk, onSettings, onPush }: {
  data: Data; onAsk: (q?: string, prefill?: boolean) => void; onSettings: () => void; onPush: () => void
}) {
  const { health, dash, stats, insight, range, setRange, offline, feedback, discard } = data
  const m = stats?.metrics
  const date = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
  const connected = !offline && health?.gmail_connected

  const metrics: { label: string; value?: number; change?: number | null; icon: LucideIcon; tone: string }[] = [
    { label: 'Urgent', value: m?.urgent.value, change: m?.urgent.change, icon: AlertTriangle, tone: 'red' },
    { label: 'Needs reply', value: m?.needs_reply.value, change: m?.needs_reply.change, icon: Reply, tone: 'orange' },
    { label: 'Drafts', value: m?.drafts.value, icon: FileText, tone: 'blue' },
    { label: 'Processed', value: m?.processed.value, change: m?.processed.change, icon: Inbox, tone: 'green' },
  ]

  return (
    <div className="page dashboard">
      <header className="large-title">
        <div>
          <p className="eyebrow">{date}</p>
          <h1>{greeting()}</h1>
        </div>
        <div className="title-actions">
          <button className="circle-btn" onClick={onPush} aria-label="Turn on notifications"><BellIcon /></button>
          <button className="circle-btn" onClick={onSettings} aria-label="Settings"><Settings size={18} /></button>
        </div>
      </header>

      <div className="status-line">
        <span className={`dot ${connected ? 'ok' : 'bad'}`} />
        {offline ? 'Backend offline' : connected ? health?.account : 'Gmail needs reconnecting'}
        {health?.quiet_now && <span className="tag">Quiet hours</span>}
      </div>
      {health && !health.gmail_connected && !offline && (
        <div className="notice red">Gmail access expired. Run <code>uv run python -m app.scripts.connect</code> in the backend folder.</div>
      )}
      {health?.backfill && <div className="notice">Indexing recent mail… {health.backfill.done} of {health.backfill.total}</div>}

      <button className="card summary" onClick={() => onAsk('Give me a quick briefing of my inbox.')}>
        <span className="summary-head"><Sparkles size={16} aria-hidden /> Summary</span>
        {insight ? <p>{insight.brief}</p> : <Skeleton lines={2} />}
        <span className="summary-cta">Ask for details <ChevronRight size={14} aria-hidden /></span>
      </button>

      <div className="section-row">
        <h2>Overview</h2>
        <Segmented label="Range" value={range} onChange={setRange}
          options={[{ value: 'today', label: 'Today' }, { value: '7d', label: 'Week' }]} />
      </div>
      <div className="metric-grid">
        {metrics.map(x => (
          <div key={x.label} className="card metric">
            <div className="metric-head"><IconTile icon={x.icon} tone={x.tone} /><Trend change={x.change} /></div>
            <strong>{x.value ?? '–'}</strong>
            <span>{x.label}</span>
          </div>
        ))}
      </div>

      <div className="two-col">
        <section>
          <h2 className="section-title">Needs attention</h2>
          <div className="group">
            {dash?.urgent.map(u => {
              const [icon, tone, label] = cat(u.category)
              return (
                <div key={u.id} className="cell">
                  <button className="cell-main" onClick={() => onAsk(`Tell me about the ${label.toLowerCase()} email from ${senderName(u.sender)} (thread ${u.thread_id}).`)}>
                    <IconTile icon={icon} tone={tone} />
                    <span className="cell-text">
                      <span className="cell-title">{senderName(u.sender)}<small>{timeAgo(u.received_at)}</small></span>
                      <span className="cell-sub">{u.summary}</span>
                    </span>
                  </button>
                  <div className="cell-actions">
                    <button onClick={() => feedback(u.id, 'handled')}><CircleCheck size={14} /> Done</button>
                    <button onClick={() => feedback(u.id, 'not_urgent')}>Not urgent</button>
                    <button onClick={() => feedback(u.id, 'always_alert')}>Always alert</button>
                    <a href={gmailLink(u.thread_id)} target="_blank" rel="noreferrer" aria-label="Open in Gmail"><ExternalLink size={14} /></a>
                  </div>
                </div>
              )
            })}
            {dash?.needs_reply.map(r => (
              <div key={r.thread_id} className="cell">
                <div className="cell-main static">
                  <IconTile icon={Reply} tone="orange" />
                  <span className="cell-text">
                    <span className="cell-title">{senderName(r.sender)}<small>{timeAgo(r.received_at)}</small></span>
                    <span className="cell-sub">{r.summary}</span>
                  </span>
                </div>
                <div className="cell-actions">
                  <button onClick={() => onAsk(`Draft a reply to ${senderName(r.sender)} (thread ${r.thread_id}) saying `, true)}><MessageCircle size={14} /> Draft reply</button>
                  <a href={gmailLink(r.thread_id)} target="_blank" rel="noreferrer" aria-label="Open in Gmail"><ExternalLink size={14} /></a>
                </div>
              </div>
            ))}
            {dash && !dash.urgent.length && !dash.needs_reply.length && (
              <div className="cell empty"><CircleCheck size={18} aria-hidden /> You're all caught up.</div>
            )}
            {!dash && <div className="cell"><Skeleton lines={2} /></div>}
          </div>

          {!!dash?.drafts.length && <>
            <h2 className="section-title">Drafts to review</h2>
            <div className="group">
              {dash.drafts.map(d => (
                <details key={d.draft_id} className="cell">
                  <summary className="cell-main">
                    <IconTile icon={FileText} tone="blue" />
                    <span className="cell-text">
                      <span className="cell-title">To {d.to}</span>
                      <span className="cell-sub">{d.subject}</span>
                    </span>
                    <ChevronRight size={16} className="chev" aria-hidden />
                  </summary>
                  <p className="draft-body">{d.snippet}</p>
                  <div className="cell-actions">
                    <a className="text-link" href="https://mail.google.com/mail/u/0/#drafts" target="_blank" rel="noreferrer">Open in Gmail</a>
                    <button className="destructive" onClick={() => discard(d.draft_id)}>Discard</button>
                  </div>
                </details>
              ))}
            </div>
          </>}
        </section>

        <section>
          <h2 className="section-title">Inbox this week</h2>
          <div className="card chart-card">
            <div className="chart-top"><strong>{stats?.week_total ?? '–'}</strong><span>emails received</span></div>
            {stats ? <BarChart data={stats.daily} /> : <Skeleton lines={4} />}
          </div>

          <h2 className="section-title">Highlights</h2>
          <div className="group">
            {insight?.findings.map((f, i) => (
              <button key={i} className="cell cell-main" onClick={() => onAsk(f.ask)}>
                <IconTile icon={Sparkles} tone="purple" />
                <span className="cell-text"><span className="cell-title">{f.title}</span><span className="cell-sub">{f.detail}</span></span>
                <ChevronRight size={16} className="chev" aria-hidden />
              </button>
            ))}
            {stats?.categories.slice(0, 5).map(c => {
              const [icon, tone, label] = cat(c.category)
              return (
                <button key={c.category} className="cell cell-main" onClick={() => onAsk(`Summarise my ${label.toLowerCase()} emails from this week.`)}>
                  <IconTile icon={icon} tone={tone} />
                  <span className="cell-text"><span className="cell-title">{label}</span></span>
                  <span className="cell-value">{c.count}</span>
                  <ChevronRight size={16} className="chev" aria-hidden />
                </button>
              )
            })}
            {!insight && <div className="cell"><Skeleton lines={3} /></div>}
          </div>
        </section>
      </div>
    </div>
  )
}

function BellIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
}
