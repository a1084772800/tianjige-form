/* 想法台 service worker（1017 v2）：收推送弹通知 + 角标、点通知开页面、缓存壳与上一份数据包（离线能开）。
   scope 是 /tianjige-form/（render.html 也在里面）：fetch 只接管下面点名的几个地址，其余一律不 respondWith，对别的页面零影响。 */
var VERSION = 'idea-v2';
var SHELL = ['./idea.html', './idea.webmanifest', './assets/idea/icon-192.png', './assets/idea/icon-512.png', './assets/idea/apple-touch-icon.png'];
var DATA_HOST = 'v609a76lof.sealoshzh.site';
var DATA_PATH = '/get_render';
var DATA_ID = 'ideadata-b03162e9a72e8fcd8339';

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(SHELL).catch(function () {}); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) { return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});

function isShell(url) { return url.origin === self.location.origin && SHELL.some(function (p) { return url.pathname.endsWith(p.slice(1)); }); }
function isData(url) { return url.hostname === DATA_HOST && url.pathname === DATA_PATH && url.searchParams.get('id') === DATA_ID; }

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url; try { url = new URL(e.request.url); } catch (_) { return; }
  if (!isShell(url) && !isData(url)) return;      // 别的地址不碰
  var net = fetch(e.request).then(function (res) {
    if (res && res.ok) { var copy = res.clone(); caches.open(VERSION).then(function (c) { c.put(e.request, copy); }); }
    return res;
  });
  if (isShell(url)) {   // 壳：有缓存先秒出，后台拿新版下次用；没缓存等网络
    e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
      var fallback = net.catch(function () { return hit || Response.error(); });
      if (hit) { e.waitUntil(fallback); return hit; }
      return fallback;
    }));
    return;
  }
  // 数据：网络优先，断网回上一份
  e.respondWith(net.catch(function () { return caches.match(e.request).then(function (hit) { return hit || Response.error(); }); }));
});

self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  var title = d.title || '想法台';
  var jobs = [self.registration.showNotification(title, {
    body: d.body || '', icon: 'assets/idea/icon-192.png', badge: 'assets/idea/icon-192.png',
    tag: d.tag || 'idea', renotify: !!d.tag, data: { url: d.url || './idea.html' }
  })];
  if (typeof d.badge === 'number' && self.navigator && 'setAppBadge' in self.navigator) {
    jobs.push((d.badge > 0 ? self.navigator.setAppBadge(d.badge) : self.navigator.clearAppBadge()).catch(function () {}));
  }
  e.waitUntil(Promise.all(jobs));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || './idea.html', self.location.href).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].url.split('#')[0].split('?')[0] === url.split('#')[0].split('?')[0] && 'focus' in list[i]) {
        return list[i].focus().then(function (c) { return c && c.navigate ? c.navigate(url) : c; });
      }
    }
    return self.clients.openWindow(url);
  }));
});
