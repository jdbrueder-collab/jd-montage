/* Service Worker: macht die App installierbar, hält die App-Dateien offline vor
   und lädt Fotos (_blob/<id>) mit dem Login-Token aus dem privaten Supabase-Speicher. */
const VERSION = "jd-montage-v3";
const SHELL = ["./", "index.html", "claude-shim.js", "config.js", "manifest.webmanifest", "icon-192.png", "icon-512.png"];

self.addEventListener("install", e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== VERSION && k !== "jd-auth" && k !== "jd-blobs") await caches.delete(k);
  await self.clients.claim();
})()));

let cfg = null;
async function config() {
  if (cfg) return cfg;
  const txt = await (await fetch("config.js")).text();
  cfg = { url: txt.match(/url:\s*"([^"]+)"/)[1], key: txt.match(/key:\s*"([^"]+)"/)[1] };
  return cfg;
}

async function blob(req, id) {
  const store = await caches.open("jd-blobs");
  const hit = await store.match(req);
  if (hit) return hit;
  const { url, key } = await config();
  const token = await (await (await caches.open("jd-auth")).match("token"))?.text();
  const res = await fetch(`${url}/storage/v1/object/authenticated/assets/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token || key}`, apikey: key }
  });
  if (res.ok) store.put(req, res.clone()); // Fotos ändern sich nie, Kennung ist eindeutig
  return res;
}

self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || e.request.method !== "GET") return;
  const m = u.pathname.match(/\/_blob\/([^/]+)$/);
  if (m) return e.respondWith(blob(e.request, decodeURIComponent(m[1])));
  // App-Dateien: erst Netz (immer aktuell), offline aus dem Zwischenspeicher
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const c = r.clone(); caches.open(VERSION).then(s => s.put(e.request, c)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});

// Handy-Benachrichtigungen (z. B. „Abholbereit: 17714/1“)
self.addEventListener("push", e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (err) { d = { titel: "JD Brüder Montage", text: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.titel || "JD Brüder Montage", {
    body: d.text || "", icon: "icon-192.png", badge: "icon-192.png", tag: d.url || "jd", renotify: true, data: { url: d.url || "./" }
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "./", self.registration.scope).href;
  e.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of tabs) { if (c.url.startsWith(self.registration.scope)) { await c.focus(); c.navigate(url).catch(() => {}); return; } }
    await self.clients.openWindow(url);
  })());
});
