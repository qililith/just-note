let updating = false

self.addEventListener('install', () => {
  updating = Boolean(self.registration.active)
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await self.clients.claim()
    if (!updating) return
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    await Promise.all(windows.map((client) => client.navigate(client.url)))
  })())
})
