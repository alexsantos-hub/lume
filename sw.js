// Lume — funciona offline. Página: rede primeiro (pega atualizações), cache se offline.
// 'no-cache' faz o navegador confirmar com o servidor a cada acesso, em vez de usar a cópia
// guardada por até 10 min (GitHub Pages). Sem mudanças, a resposta é um 304 curtinho.
const CACHE = 'lume-v2';
const SHELL = ['./', 'index.html', 'sync.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (url.origin === location.origin) {
    e.respondWith(fetch(req, { cache: 'no-cache' }).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return r; })
      .catch(() => caches.match(req).then(r => r || caches.match('index.html'))));
  } else if (url.hostname === 'cdnjs.cloudflare.com') {
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res; })));
  }
  // Google (login/Drive) e cotações: sempre direto pela rede, nunca em cache.
});
