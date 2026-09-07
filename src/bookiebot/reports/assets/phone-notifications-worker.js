/* Web Push only. Deliberately no fetch handler or financial data cache. */
self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (_) { /* Show a private fallback. */ }
  const body = typeof payload.body === "string" ? payload.body.slice(0, 300) : "Open BookieBot for your latest report.";
  const tag = typeof payload.tag === "string" ? payload.tag.slice(0, 80) : "bookiebot-update";
  event.waitUntil(self.registration.showNotification("BookieBot", {
    body, tag, icon: "/app/icon.png", badge: "/app/icon.png", data: { url: "/app/expenses" },
  }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin && new URL(client.url).pathname === "/app/expenses");
    if (existing) return existing.focus();
    return self.clients.openWindow("/app/expenses");
  })());
});
