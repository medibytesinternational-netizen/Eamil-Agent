self.addEventListener('push', event => {
  let data = { title: 'Inbox Agent', body: 'New alert', url: '/' }
  try { data = { ...data, ...event.data.json() } } catch {}
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body, data: { url: data.url }, tag: data.url, renotify: true,
  }))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil(clients.openWindow(event.notification.data?.url || '/'))
})
