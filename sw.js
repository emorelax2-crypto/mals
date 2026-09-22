/* Офлайн-кэш. Страницу берём из СЕТИ и только при неудаче из кэша — иначе
   установленная игра навсегда застревает на старой сборке. Картинки и иконки,
   наоборот, отдаём из кэша сразу: они меняются редко.
   Имя кэша содержит версию: при её смене старый кэш удаляется в activate. */
const VERSION = "v3";
const CACHE = "sergey-zhirny-" + VERSION;
const ASSETS = [
  "./", "./index.html", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png",
  "./icons/icon-180.png", "./icons/icon-32.png",
  "./icons/icon-maskable-512.png"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function putCopy(req, res){
  const copy = res.clone();
  caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
  return res;
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== self.location.origin) return;

  const isPage = req.mode === "navigate" || req.destination === "document" ||
                 new URL(req.url).pathname.replace(/\/$/, "").endsWith("/index.html");

  if (isPage){
    e.respondWith(
      fetch(req)
        .then(res => putCopy(req, res))
        .catch(() => caches.match(req).then(hit => hit || caches.match("./index.html")))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => putCopy(req, res)))
  );
});
