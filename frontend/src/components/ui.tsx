import { ArrowLeft, Mic, TrendingDown, TrendingUp, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { VoiceState } from '../lib/realtime'

export function IconTile({ icon: Icon, tone = 'violet' }: { icon: LucideIcon; tone?: string }) {
  return <span className={`icon-tile ${tone}`}><Icon size={18} strokeWidth={2} aria-hidden /></span>
}

export function Trend({ change }: { change: number | null }) {
  if (change === null || change === undefined) return null
  const up = change >= 0
  return (
    <span className={`trend ${up ? 'up' : 'down'}`}>
      {up ? <TrendingUp size={12} aria-hidden /> : <TrendingDown size={12} aria-hidden />}
      {Math.abs(change)}%
    </span>
  )
}

export function MetricCard({ icon, tone, label, value, change, onClick, active }: {
  icon: LucideIcon; tone: string; label: string; value?: number; change?: number | null; onClick?: () => void; active?: boolean
}) {
  return (
    <button className={`metric glass ${active ? 'active' : ''}`} onClick={onClick} aria-pressed={active}>
      <div className="metric-top"><IconTile icon={icon} tone={tone} /><Trend change={change ?? null} /></div>
      <span className="metric-label">{label}</span>
      <strong className="metric-value">{value ?? '–'}</strong>
    </button>
  )
}

export function ScreenHeader({ title, onBack, right }: { title: string; onBack?: () => void; right?: ReactNode }) {
  return (
    <div className="screen-header">
      {onBack ? <button className="round-btn" onClick={onBack} aria-label="Back"><ArrowLeft size={18} /></button> : <span className="round-spacer" />}
      <h2>{title}</h2>
      {right ?? <span className="round-spacer" />}
    </div>
  )
}

export function BarChart({ data }: { data: { label: string; count: number }[] }) {
  const max = Math.max(1, ...data.map(d => d.count))
  const W = 300, H = 150, gap = 10
  const bw = (W - gap * (data.length - 1)) / Math.max(1, data.length)
  const pts = data.map((d, i) => [i * (bw + gap) + bw / 2, H - 14 - (d.count / max) * (H - 34)] as const)
  const path = pts.map((p, i) => {
    if (i === 0) return `M${p[0]},${p[1]}`
    const [px, py] = pts[i - 1]
    const cx = (px + p[0]) / 2
    return `C${cx},${py} ${cx},${p[1]} ${p[0]},${p[1]}`
  }).join(' ')
  const peak = data.reduce((b, d, i) => (d.count > data[b].count ? i : b), 0)
  return (
    <svg className="bar-chart" viewBox={`0 0 ${W} ${H + 18}`} role="img"
      aria-label={`Emails per day: ${data.map(d => `${d.label} ${d.count}`).join(', ')}`}>
      <defs>
        <linearGradient id="bar" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8b8b97" stopOpacity=".75" /><stop offset="1" stopColor="#8b8b97" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="barOn" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8f7dff" /><stop offset="1" stopColor="#5b4bd1" stopOpacity=".55" />
        </linearGradient>
      </defs>
      {data.map((d, i) => {
        const h = Math.max(6, (d.count / max) * (H - 34))
        return (
          <g key={i}>
            <rect x={i * (bw + gap)} y={H - h} width={bw} height={h} rx={bw / 2.6} fill={i === peak ? 'url(#barOn)' : 'url(#bar)'} />
            <text x={i * (bw + gap) + bw / 2} y={H + 14} textAnchor="middle" className="bar-label">{d.label}</text>
          </g>
        )
      })}
      <path d={path} fill="none" stroke="rgba(255,255,255,.55)" strokeWidth="1.6" />
      <circle cx={pts[peak][0]} cy={pts[peak][1]} r="4.5" fill="#fff" stroke="#8f7dff" strokeWidth="2" />
    </svg>
  )
}

const VOICE_LABEL: Record<VoiceState, string> = {
  idle: 'Start voice (Space)', connecting: 'Connecting…', listening: 'Listening — tap to end',
  thinking: 'Thinking…', speaking: 'Speaking — talk to interrupt',
}

export function VoiceButton({ state, onClick }: { state: VoiceState; onClick: () => void }) {
  return (
    <button type="button" className={`voice-btn ${state}`} onClick={onClick} aria-label={VOICE_LABEL[state]} title={VOICE_LABEL[state]}>
      {state === 'speaking'
        ? <span className="wave" aria-hidden><i /><i /><i /><i /></span>
        : <Mic size={18} aria-hidden />}
    </button>
  )
}

export const voiceLabel = (s: VoiceState) => VOICE_LABEL[s]

export function Skeleton({ lines = 2 }: { lines?: number }) {
  return <div className="skeleton" aria-hidden>{Array.from({ length: lines }, (_, i) => <span key={i} />)}</div>
}
