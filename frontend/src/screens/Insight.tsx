import { AlertTriangle, ChevronRight, Cpu, FileText, Inbox, Megaphone, RefreshCw, Reply, ShieldAlert, Tag, User, Wallet, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { BarChart, IconTile, ScreenHeader, Skeleton, Trend } from '../components/ui'
import type { Insight as InsightT } from '../hooks/useAgentData'

const CAT_ICON: Record<string, [LucideIcon, string, string]> = {
  payment: [Wallet, 'red', 'Payments & bills'], security: [ShieldAlert, 'red', 'Security'],
  reply_needed: [Reply, 'amber', 'Reply needed'], deadline: [AlertTriangle, 'amber', 'Deadlines'],
  newsletter: [Megaphone, 'blue', 'Newsletters'], promo: [Tag, 'blue', 'Promotions'],
  personal: [User, 'green', 'Personal'], otp: [ShieldAlert, 'teal', 'One-time codes'], other: [Inbox, 'violet', 'Other'],
}

function Headline({ text }: { text: string }) {
  // Highlight the first number-ish token (e.g. "18%", "42") in lime, like the reference.
  const m = text.match(/(\d+(?:\.\d+)?%?)/)
  if (!m || m.index === undefined) return <h1 className="insight-headline">{text}</h1>
  return (
    <h1 className="insight-headline">
      {text.slice(0, m.index)}<span className="lime">{m[0]}</span>{text.slice(m.index + m[0].length)}
    </h1>
  )
}

export function Insight({ insight, onBack, onAsk, onRefresh }: {
  insight: InsightT | null; onBack?: () => void; onAsk: (q: string) => void; onRefresh: () => Promise<unknown>
}) {
  const [spinning, setSpinning] = useState(false)
  const refresh = async () => { setSpinning(true); await onRefresh(); setSpinning(false) }
  const st = insight?.stats

  return (
    <div className="screen insight">
      <ScreenHeader title="Ask Insight" onBack={onBack}
        right={<button className="round-btn" onClick={refresh} aria-label="Refresh insight"><RefreshCw size={16} className={spinning ? 'spin' : ''} /></button>} />

      {insight ? <Headline text={insight.headline} /> : <Skeleton lines={2} />}

      <section className="glass chart-card">
        <div className="chart-head"><span>Inbox volume</span><strong>{st?.week_total ?? '–'}</strong></div>
        <small className="muted">Emails received, last 7 days</small>
        {st ? <BarChart data={st.daily} /> : <Skeleton lines={4} />}
      </section>

      {insight?.explanation && (
        <section className="glass explain">
          <div className="explain-head"><IconTile icon={Cpu} tone="teal" /><strong>AI explanation</strong></div>
          <p>{insight.explanation}</p>
        </section>
      )}

      <h3 className="section-title">Key findings</h3>
      <div className="findings">
        {insight?.findings.map((f, i) => (
          <button key={i} className="row glass row-main" onClick={() => onAsk(f.ask)}>
            <IconTile icon={i === 0 ? AlertTriangle : i === 1 ? Reply : FileText} tone={['red', 'amber', 'blue', 'green'][i % 4]} />
            <span className="row-text"><strong>{f.title}</strong><span>{f.detail}</span></span>
            <ChevronRight size={16} aria-hidden />
          </button>
        ))}
        {st?.categories.slice(0, 6).map(c => {
          const [icon, tone, label] = CAT_ICON[c.category] ?? CAT_ICON.other
          return (
            <button key={c.category} className="row glass row-main" onClick={() => onAsk(`Summarise my ${label.toLowerCase()} emails from this week.`)}>
              <IconTile icon={icon} tone={tone} />
              <span className="row-text"><strong>{label}</strong><span>{c.count} this week</span></span>
              <Trend change={c.change} />
            </button>
          )
        })}
        {!insight && <Skeleton lines={3} />}
      </div>
      {insight && <small className="muted foot">Updated {new Date(insight.generated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>}
    </div>
  )
}
