/* 想法台 service worker（1017）：只做两件事——收到推送弹通知、点通知开页面。不缓存任何资源，不拦 fetch。
   scope 是 /tianjige-form/（render.html 也在里面），对它们零影响。 */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  var title = d.title || '想法台';
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    icon: 'assets/idea/icon-192.png',
    badge: 'assets/idea/icon-192.png',
    tag: d.tag || 'idea',
    renotify: !!d.tag,
    data: { url: d.url || './idea.html' }
  }));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || './idea.html', self.location.href).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].url.split('#')[0] === url.split('#')[0] && 'focus' in list[i]) return list[i].focus();
    }
    return self.clients.openWindow(url);
  }));
});
