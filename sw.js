/* Service Worker：讓這支 app 加到手機桌面後開得快，而且網路不穩時畫面還打得開。
 *
 * 規則很簡單：
 *   靜態資源（HTML／CSS／JS／icon）→ **網路優先**，連不上才用快取
 *   後端 API（Apps Script）        → 一律走網路，永不快取
 *
 * 為什麼不是常見的「快取優先」：這是帳本，改版後還在跑舊程式會算錯錢，
 * 比慢個半秒嚴重得多。快取只留一個用途——沒網路時畫面還打得開。
 *
 * 改版時把 VERSION 加一，舊快取會在啟用時全部清掉。
 */
var VERSION = 'cashbook-v17';
var ASSETS = [
  './', './index.html', './manifest.json',
  './css/base.css',
  './js/config.js', './js/calc.js', './js/demo-data.js', './js/mock-data.js',
  './js/api.js', './js/busy.js', './js/memory.js', './js/export.js', './js/app.js',
  './js/vendor/xlsx.mini.min.js',
  './js/views/login.js', './js/views/entry.js', './js/views/list.js', './js/views/export.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-180.png',
  './assets/logo-mark.png', './assets/logo-full.png'
];

self.addEventListener('install', function (e) {
  // addAll 走的是預設快取模式，會把 HTTP 快取裡的舊檔裝進來；明講 reload 才拿得到新的
  var reqs = ASSETS.map(function (u) { return new Request(u, { cache: 'reload' }); });
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(reqs); })
                    .then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; })
                           .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var url = e.request.url;
  // 後端一律不快取：看到過期的帳比看不到還糟
  if (e.request.method !== 'GET' || url.indexOf('script.google.com') >= 0) return;

  /* 一定要自己指定 no-cache，不然「網路優先」是假的：
     GitHub Pages 給靜態檔的是 max-age=600，瀏覽器的 HTTP 快取會在這十分鐘內
     直接把舊檔交出來，fetch() 根本到不了網路。2026-09-10 v16 上線時實測到
     頁尾已經顯示 v16（那是讀 SW 快取，是新的）、但頁面實際跑的 js/app.js 還是 v15，
     正好是那個版本號要防的情況。no-cache 不是不快取，是每次都跟伺服器對一下，
     沒改就回 304，成本很小。 */
  var fresh = new Request(e.request.url, { cache: 'no-cache', credentials: 'same-origin' });

  e.respondWith(
    fetch(fresh).then(function (res) {
      if (res && res.status === 200 && res.type === 'basic') {
        var copy = res.clone();
        caches.open(VERSION).then(function (c) { c.put(e.request, copy); });
      }
      return res;
    }).catch(function () {
      // 只有連不上網路時才回快取——這是離線備援，不是加速手段
      return caches.match(e.request);
    })
  );
});
