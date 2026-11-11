import { LogOut, RefreshCw, Repeat, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../lib/api'

type Account = { email: string; active: boolean; last_used: string | null }
type Progress = { done: number; total: number; finished?: boolean }

// Account changes reload the app so every screen picks up the other account's local data.
const reload = () => window.location.assign('/')

export function AccountSection({ onErr }: { onErr: (e: unknown) => void }) {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const [deleting, setDeleting] = useState<string | null>(null)
  const [confirm, setConfirm] = useState('')
  const [recheck, setRecheck] = useState<Progress | null>(null)

  const load = () => api<{ active: string | null; accounts: Account[] }>('/api/accounts')
    .then(r => { setAccounts(r.accounts); setActive(r.active) }).catch(onErr)
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const es = new EventSource('/api/events')
    es.addEventListener('recheck', e => {
      try { const d = JSON.parse((e as MessageEvent).data || '{}'); setRecheck(d.finished ? { ...d } : d) } catch { /* ignore */ }
    })
    return () => es.close()
  }, [])

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    try { await fn() } catch (e) { onErr(e) } finally { setBusy('') }
  }

  const disconnect = () => run('disconnect', async () => {
    if (!window.confirm(`Disconnect ${active}? Google access is revoked. This account's data stays on this device, so you can reconnect later.`)) return
    await api('/api/account/disconnect', { method: 'POST' })
    reload()
  })
  // Switching keeps the other account's sign-in (only the active account is polled), so switching back is instant.
  // If the account was disconnected earlier, the app opens the Connect step for it.
  const switchTo = (email: string) => run(`switch:${email}`, async () => {
    await api('/api/account/switch', { json: { email } })
    reload()
  })
  const remove = (email: string) => run(`delete:${email}`, async () => {
    await api(`/api/account/${encodeURIComponent(email)}`, { method: 'DELETE', json: { confirm } })
    setDeleting(null); setConfirm(''); load()
  })
  const startRecheck = () => run('recheck', async () => {
    await api('/api/recheck', { json: { days: 14 } })
    setRecheck({ done: 0, total: 0 })
  })

  const others = accounts.filter(a => a.email !== active)
  const pct = recheck?.total ? Math.round((recheck.done / recheck.total) * 100) : 0

  return (
    <div className="field acct">
      <span>Gmail account</span>
      <div className="acct-row">
        <strong className="acct-email">{active ?? 'Not connected'}</strong>
        {active && (
          <button className="btn outline sm" onClick={disconnect} disabled={!!busy}>
            <LogOut size={14} /> Disconnect
          </button>
        )}
      </div>
      <small>Each Gmail account keeps its own data on this device. Nothing is stored in another cloud.</small>

      {active && (
        <div className="acct-recheck">
          <button className="btn outline wide" onClick={startRecheck} disabled={!!busy || (!!recheck && !recheck.finished)}>
            <RefreshCw size={15} className={recheck && !recheck.finished ? 'spin' : ''} /> Re-check last 2 weeks with my rules
          </button>
          {recheck && (
            <small>{recheck.finished ? `Done — ${recheck.total} emails re-checked.` : recheck.total ? `Re-checking ${recheck.done} of ${recheck.total}… (${pct}%)` : 'Starting…'}</small>
          )}
        </div>
      )}

      {!!others.length && (
        <div className="acct-others">
          <span className="muted">Other accounts on this device</span>
          <ul>
            {others.map(a => (
              <li key={a.email}>
                <span className="acct-email">{a.email}</span>
                <span className="acct-actions">
                  <button className="link-btn" onClick={() => switchTo(a.email)} disabled={!!busy}><Repeat size={13} /> Switch</button>
                  <button className="link-btn danger" onClick={() => { setDeleting(a.email); setConfirm('') }} disabled={!!busy}><Trash2 size={13} /> Delete data</button>
                </span>
                {deleting === a.email && (
                  <div className="acct-delete">
                    <small>This permanently deletes this account's emails, rules and settings from this device. Type the address to confirm.</small>
                    <input value={confirm} onChange={e => setConfirm(e.target.value)} placeholder={a.email} aria-label="Type the email to confirm" />
                    <div className="acct-actions">
                      <button className="btn outline sm" onClick={() => setDeleting(null)}>Cancel</button>
                      <button className="btn sm danger-btn" disabled={confirm.trim().toLowerCase() !== a.email || !!busy} onClick={() => remove(a.email)}>Delete permanently</button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
