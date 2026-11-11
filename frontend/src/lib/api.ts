export class AuthError extends Error {}

export async function api<T = any>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {}
  const r = await fetch(path, {
    ...rest,
    method: rest.method ?? (json !== undefined ? 'POST' : 'GET'),
    headers: json !== undefined ? { 'Content-Type': 'application/json', ...rest.headers } : rest.headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  })
  if (r.status === 401) throw new AuthError()
  if (!r.ok) {
    const detail = (await r.json().catch(() => ({}))).detail
    const msg = Array.isArray(detail) ? String(detail[0]?.msg ?? '').replace(/^Value error, /, '') : detail
    throw new Error(msg || `Request failed (${r.status})`)
  }
  return r.json()
}

function b64ToUint8(b64: string) {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4))
  return Uint8Array.from(s, c => c.charCodeAt(0))
}

export async function enablePush(vapidKey: string): Promise<string> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'This browser does not support push notifications.'
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') return 'Notifications were blocked. Allow them in the browser site settings.'
  const reg = await navigator.serviceWorker.register('/sw.js')
  await navigator.serviceWorker.ready
  const sub = (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(vapidKey) }))
  await api('/api/push/subscribe', { json: sub.toJSON() })
  await api('/api/push/test', { method: 'POST' })
  return 'Notifications on. A test alert was sent.'
}
