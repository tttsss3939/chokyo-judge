/*
 * sw.js — オフライン対応
 *   - アプリ本体（HTML/JS/データ）: ネット優先。つながらないときだけキャッシュ（更新がすぐ届くように）
 *   - vendor/（Tesseract.js・OCRモデル、約13MB）: キャッシュ優先。中身は版ごとに固定なので一度取れば十分
 * vendor の中身を差し替えたら VENDOR_CACHE の版を上げる。
 */
// 版番号。更新したら index.html の app-version と合わせて上げる（sw.js が変わると端末側で更新が走る）
const APP_CACHE = 'chokyo-app-2026.10.12-1';
const VENDOR_CACHE = 'chokyo-vendor-tesseract-5.1.1';
const APP_FILES = [
  './', 'index.html', 'manifest.webmanifest',
  'js/app.js', 'js/judge.js', 'js/ocr.js', 'js/comment.js',
  'icons/icon-192.png', 'icons/apple-touch-icon.png',
];
const VENDOR_FILES = [
  'vendor/tesseract/tesseract.min.js', 'vendor/tesseract/worker.min.js',
  'vendor/tesseract/tesseract-core-simd-lstm.wasm.js', 'vendor/tesseract/tesseract-core-lstm.wasm.js',
  'vendor/tesseract/lang/eng.traineddata.gz', 'vendor/tesseract/lang/jpn.traineddata.gz',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil((async () => {
    // reload: ブラウザのHTTPキャッシュ（GitHub Pages は10分）に残った古い版を拾わない
    await (await caches.open(APP_CACHE)).addAll(APP_FILES.map((u) => new Request(u, { cache: 'reload' })));
    // OCR 一式は大きいので、失敗してもインストールは止めない（使ったときにキャッシュされる）
    try { await (await caches.open(VENDOR_CACHE)).addAll(VENDOR_FILES); } catch (e) { /* noop */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== APP_CACHE && k !== VENDOR_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.includes('/vendor/')) {
    ev.respondWith((async () => {
      const cache = await caches.open(VENDOR_CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
    return;
  }
  ev.respondWith((async () => {
    const cache = await caches.open(APP_CACHE);
    try {
      // no-cache: 端末に残っている古いファイルを使わず、必ずサーバーに更新を確認する
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (e) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') return (await cache.match('index.html')) || Response.error();
      throw e;
    }
  })());
});
