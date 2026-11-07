import { AlertTriangle, Bell, ChevronRight, Cpu, ExternalLink, FileText, Inbox, Reply, Settings, ShieldAlert, Sparkles, Wallet } from 'lucide-react'
import { useState } from 'react'
import { IconTile, MetricCard, Skeleton } from '../components/ui'
import type { useAgentData } from '../hooks/useAgentData'

type Data = ReturnType<typeof useAgentData>
type Filter = 'all' | 'urgent' | 'reply' | 'drafts'

const CAT: Record<string, { label: string; icon: typeof Wallet; tone: string }> = {
  payment: { label: 'Payment due', icon: Wallet, tone: 'red' },
  security: { label: 'Security', icon: ShieldAlert, tone: 'red' },
  reply_needed: { label: 'Reply needed', icon: Reply, tone: 'amber' },
  deadline: { label: 'Deadline', icon: AlertTriangle, tone: 'amber' },
}

export const senderName = (s: string) => s.replace(/<.*>/, '').replace(/"/g, '').trim() || s
export const gmailLink = (t: string) => `https://mail.google.com/mail/u/0/#all/${t}`

export function timeAgo(iso: string) {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  if (m < 60) return `${m}m ago`
  if (m < 1440) return `${Math.round(m / 60)}h ago`
  return `${Math.round(m / 1440)}d ago`
}

function greeting() {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

export function Home({ data, onAsk, onOpenInsight, onSettings, onPush, onDraftReply }: {
  data: Data; onAsk: (q?: string) => void; onOpenInsight: () => void; onSettings: () => void; onPush: () => void
  onDraftReply: (text: string) => void
}) {
  const { health, dash, stats, insight, range, setRange, offline, feedback, discard } = data
  const [filter, setFilter] = useState<Filter>('all')
  const m = stats?.metrics
  const name = (health?.account ?? '').split('@')[0].replace(/[0-9._]+/g, ' ').trim()
  const display = name ? name[0].toUpperCase() + name.slice(1) : 'there'
  const toggle = (f: Filter) => setFilter(cur => (cur === f ? 'all' : f))

  return (
    <div className="screen home">
      <header className="home-top">
        <div className="who">
          <span className="avatar" aria-hidden>{display[0]}</span>
          <div>
            <small>{greeting()}</small>
            <strong>{display}</strong>
          </div>
        </div>
        <div className="top-actions">
          <button className="round-btn" onClick={onPush} aria-label="Enable alert notifications"><Bell size={18} /></button>
          <button className="round-btn" onClick={onSettings} aria-label="Settings"><Settings size={18} /></button>
        </div>
      </header>

      <h1 className="hero"><span className="dim">Brief overview</span> of your <span className="dim">inbox</span> today.</h1>

      <div className="status-row">
        <span className={`dot ${!offline && health?.gmail_connected ? 'ok' : 'bad'}`} />
        {offline ? 'Backend offline' : health?.gmail_connected ? 'Gmail connected' : 'Gmail needs reconnecting'}
        {health?.quiet_now && <span className="pill small">Quiet hours</span>}
      </div>
      {health && !health.gmail_connected && !offline && (
        <div className="banner">Gmail access expired. Run <code>uv run python -m app.scripts.connect</code> in the backend folder.</div>
      )}
      {health?.backfill && <div className="banner info">Indexing recent mail… {health.backfill.done}/{health.backfill.total}</div>}

      <div className="section-head">
        <span className="section-title"><Inbox size={16} aria-hidden /> Key metrics</span>
        <select className="pill" value={range} onChange={e => setRange(e.target.value as 'today' | '7d')} aria-label="Range">
          <option value="today">Today</option>
          <option value="7d">This week</option>
        </select>
      </div>
      <div className="metrics">
        <MetricCard icon={AlertTriangle} tone="red" label="Urgent" value={m?.urgent.value} change={m?.urgent.change}
          onClick={() => toggle('urgent')} active={filter === 'urgent'} />
        <MetricCard icon={Reply} tone="amber" label="Needs reply" value={m?.needs_reply.value} change={m?.needs_reply.change}
          onClick={() => toggle('reply')} active={filter === 'reply'} />
        <MetricCard icon={FileText} tone="blue" label="Drafts waiting" value={m?.drafts.value}
          onClick={() => toggle('drafts')} active={filter === 'drafts'} />
        <MetricCard icon={Inbox} tone="green" label="Processed" value={m?.processed.value} change={m?.processed.change} />
      </div>

      <button className="insight-card glass" onClick={onOpenInsight}>
        <IconTile icon={Cpu} tone="teal" />
        <span className="insight-text">
          <strong>AI Insight</strong>
          {insight ? <span>{insight.brief}</span> : <Skeleton lines={2} />}
        </span>
        <span className="round-btn sm" aria-hidden><ChevronRight size={16} /></span>
      </button>

      <div className="section-head">
        <span className="section-title">
          {filter === 'urgent' ? 'Urgent' : filter === 'reply' ? 'Needs reply' : filter === 'drafts' ? 'Drafts waiting' : 'Recent activity'}
        </span>
        {filter !== 'all' && <button className="link" onClick={() => setFilter('all')}>See all</button>}
      </div>

      <div className="activity">
        {(filter === 'all' || filter === 'urgent') && dash?.urgent.map(u => {
          const c = CAT[u.category ?? ''] ?? { label: u.category ?? 'Urgent', icon: AlertTriangle, tone: 'red' }
          return (
            <article key={`u${u.id}`} className="row glass">
              <button className="row-main" onClick={() => onAsk(`Tell me about the ${c.label.toLowerCase()} email from ${senderName(u.sender)} (thread ${u.thread_id}).`)}>
                <IconTile icon={c.icon} tone={c.tone} />
                <span className="row-text">
                  <strong>{c.label} · {senderName(u.sender)}</strong>
                  <span>{u.summary}</span>
                </span>
                <small className="when">{timeAgo(u.received_at)}</small>
              </button>
              <div className="row-actions">
                <button onClick={() => feedback(u.id, 'handled')}>Handled</button>
                <button onClick={() => feedback(u.id, 'not_urgent')}>Not urgent</button>
                <button onClick={() => feedback(u.id, 'always_alert')}>Always alert</button>
                <a href={gmailLink(u.thread_id)} target="_blank" rel="noreferrer" aria-label="Open in Gmail"><ExternalLink size={14} /></a>
              </div>
            </article>
          )
        })}

        {(filter === 'all' || filter === 'reply') && dash?.needs_reply.map(r => (
          <article key={`r${r.thread_id}`} className="row glass">
            <div className="row-main static">
              <IconTile icon={Reply} tone="amber" />
              <span className="row-text"><strong>{senderName(r.sender)}</strong><span>{r.summary}</span></span>
              <small className="when">{timeAgo(r.received_at)}</small>
            </div>
            <div className="row-actions">
              <button onClick={() => onDraftReply(`Draft a reply to ${senderName(r.sender)} (thread ${r.thread_id}) saying `)}>Draft reply</button>
              <a href={gmailLink(r.thread_id)} target="_blank" rel="noreferrer" aria-label="Open in Gmail"><ExternalLink size={14} /></a>
            </div>
          </article>
        ))}

        {(filter === 'all' || filter === 'drafts') && dash?.drafts.map(d => (
          <details key={`d${d.draft_id}`} className="row glass">
            <summary className="row-main">
              <IconTile icon={FileText} tone="blue" />
              <span className="row-text"><strong>To {d.to}</strong><span>{d.subject}</span></span>
              <small className="when">Draft</small>
            </summary>
            <p className="draft-body">{d.snippet}</p>
            <div className="row-actions">
              <a className="text-link" href="https://mail.google.com/mail/u/0/#drafts" target="_blank" rel="noreferrer">Open in Gmail</a>
              <button onClick={() => discard(d.draft_id)}>Discard</button>
            </div>
          </details>
        ))}

        {dash && !dash.urgent.length && !dash.needs_reply.length && !dash.drafts.length && (
          <p className="empty">All clear — nothing urgent, no one waiting, no drafts.</p>
        )}
        {!dash && <Skeleton lines={3} />}
      </div>

      <button className="ask-cta" onClick={() => onAsk()}><Sparkles size={18} aria-hidden /> Ask AI</button>
    </div>
  )
}
