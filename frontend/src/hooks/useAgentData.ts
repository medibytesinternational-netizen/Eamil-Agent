import { useCallback, useEffect, useState } from 'react'
import { api, AuthError } from '../lib/api'

export type Urgent = {
  id: number; thread_id: string; category: string | null; sender: string; summary: string | null
  reason: string | null; received_at: string; due_date: string | null; amount: { value: number; currency: string } | null
}
export type Reply = { thread_id: string; sender: string; summary: string | null; received_at: string }
export type DraftItem = { draft_id: string; thread_id: string | null; to: string | null; subject: string | null; snippet: string | null }
export type Dashboard = {
  counts: { urgent: number; needs_reply: number; drafts: number; processed_today: number; total: number }
  urgent: Urgent[]; needs_reply: Reply[]; drafts: DraftItem[]
}
export type Health = {
  gmail_connected: boolean; account: string; quiet_hours: string | null; quiet_now: boolean
  backfill: { done: number; total: number } | null; last_error: string | null; vapid_public_key: string
}
export type Metric = { value: number; change: number | null }
export type Stats = {
  range: 'today' | '7d'
  metrics: { urgent: Metric; needs_reply: Metric; drafts: Metric; processed: Metric }
  categories: { category: string; count: number; change: number | null }[]
  daily: { date: string; label: string; count: number }[]
  week_total: number
}
export type Insight = {
  brief: string; headline: string; explanation: string
  findings: { title: string; detail: string; ask: string }[]
  stats: Stats; generated_at: string
}

export function useAgentData(onAuthLost: () => void, onError: (e: unknown) => void) {
  const [health, setHealth] = useState<Health | null>(null)
  const [dash, setDash] = useState<Dashboard | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [insight, setInsight] = useState<Insight | null>(null)
  const [range, setRange] = useState<'today' | '7d'>('7d')
  const [offline, setOffline] = useState(false)

  const guard = useCallback((e: unknown) => { if (e instanceof AuthError) onAuthLost(); else onError(e) }, [onAuthLost, onError])

  const load = useCallback(() =>
    Promise.all([api<Health>('/api/health'), api<Dashboard>('/api/dashboard'), api<Stats>(`/api/stats?range=${range}`)])
      .then(([h, d, s]) => { setHealth(h); setDash(d); setStats(s); setOffline(false) })
      .catch(e => { if (e instanceof AuthError) onAuthLost(); else setOffline(true) }), [range, onAuthLost])

  const loadInsight = useCallback((refresh = false) =>
    api<Insight>(`/api/insight${refresh ? '?refresh=true' : ''}`).then(setInsight).catch(guard), [guard])

  useEffect(() => { load() }, [load])
  useEffect(() => { loadInsight() }, [loadInsight])

  useEffect(() => {
    const es = new EventSource('/api/events')
    const refresh = () => load()
    ;['email', 'alert', 'drafts', 'status', 'backfill'].forEach(ev => es.addEventListener(ev, refresh))
    const t = setInterval(load, 60000)
    return () => { es.close(); clearInterval(t) }
  }, [load])

  const feedback = async (id: number, action: 'handled' | 'not_urgent' | 'always_alert') => {
    try { await api(`/api/alerts/${id}/feedback`, { json: { action } }); load() } catch (e) { guard(e) }
  }
  const discard = async (id: string) => {
    try { await api(`/api/drafts/${id}/discard`, { method: 'POST' }); load() } catch (e) { guard(e) }
  }

  return { health, dash, stats, insight, range, setRange, offline, load, loadInsight, feedback, discard }
}
