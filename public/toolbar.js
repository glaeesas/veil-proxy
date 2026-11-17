// Injected into every proxied page by public/sw.js. Ultraviolet already
// rewrites URLs, so this only carries the toolbar, the anti-close guard and the
// transport connection. Shadow DOM, so no page CSS can touch it.
(function () {
  'use strict';

  var GUARD_KEY = 'veil.anticlose';
  var UV = self.__uv$config || {};
  var PREFIX = UV.prefix || '/service/';

  function guardEnabled() {
    try { return localStorage.getItem(GUARD_KEY) !== 'off'; } catch (err) { return true; }
  }

  function setGuard(enabled) {
    try { localStorage.setItem(GUARD_KEY, enabled ? 'on' : 'off'); } catch (err) { /* ignore */ }
  }

  var internalNav = false;
  self.__veilInternalNav = function () {
    internalNav = true;
    setTimeout(function () { internalNav = false; }, 4000);
  };

  self.addEventListener('beforeunload', function (event) {
    if (!guardEnabled() || internalNav) return undefined;
    event.preventDefault();
    event.returnValue = 'Leave Veil?';
    return 'Leave Veil?';
  });

  // Navigating inside the proxy is a reload of the same origin, so the guard
  // must not fire for it.
  document.addEventListener(
    'click',
    function (event) {
      var anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
      if (!anchor) return;
      try {
        if (anchor.href.indexOf(location.origin + PREFIX) === 0) self.__veilInternalNav();
      } catch (err) { /* ignore */ }
    },
    true,
  );

  function mount() {
    if (document.getElementById('__veil_toolbar')) return;
    var host = document.createElement('div');
    host.id = '__veil_toolbar';
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;left:18px;bottom:18px;';
    var root = host.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent = [
      ':host{all:initial}',
      '.bar{display:flex;align-items:center;gap:2px;padding:6px;border-radius:999px;',
      'background:rgba(12,10,18,.82);border:1px solid rgba(255,255,255,.14);',
      'box-shadow:0 12px 32px rgba(0,0,0,.45);backdrop-filter:blur(14px);',
      'font:500 13px ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;',
      'opacity:.42;transition:opacity .18s ease}',
      '.bar:hover{opacity:1}',
      'button{all:unset;display:inline-flex;align-items:center;justify-content:center;',
      'width:30px;height:30px;border-radius:999px;cursor:pointer;color:#e9e2fb;',
      'transition:background .15s ease,color .15s ease}',
      'button:hover{background:rgba(168,85,247,.28);color:#fff}',
      'button:focus-visible{outline:2px solid #a855f7;outline-offset:1px}',
      'svg{width:15px;height:15px;display:block}',
      '.sep{width:1px;height:18px;background:rgba(255,255,255,.16);margin:0 3px}',
    ].join('');

    var icons = {
      back: '<path d="M15 6l-6 6 6 6"/>',
      shield: '<path d="M12 4l7 3v5c0 4.2-2.9 7.4-7 8-4.1-.6-7-3.8-7-8V7z"/><path d="M9.2 12.2l2 2 3.6-3.9"/>',
      home: '<path d="M4 11l8-7 8 7"/><path d="M6.5 9.5V19h11V9.5"/>',
      reload: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4.5h-4.5"/>',
      hide: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
    };

    var bar = document.createElement('div');
    bar.className = 'bar';

    function button(icon, label, handler) {
      var el = document.createElement('button');
      el.type = 'button';
      el.title = label;
      el.setAttribute('aria-label', label);
      el.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
        'stroke-linecap="round" stroke-linejoin="round">' + icons[icon] + '</svg>';
      el.addEventListener('click', handler);
      return el;
    }

    bar.appendChild(button('back', 'Back', function () {
      self.__veilInternalNav();
      history.back();
    }));
    bar.appendChild(button('home', 'Veil home', function () {
      self.__veilInternalNav();
      location.href = '/';
    }));
    bar.appendChild(button('reload', 'Reload', function () {
      self.__veilInternalNav();
      location.reload();
    }));
    bar.appendChild(document.createElement('span')).className = 'sep';

    var guardButton = button('shield', 'Anti-close guard: on', function () {
      var next = !guardEnabled();
      setGuard(next);
      guardButton.title = 'Anti-close guard: ' + (next ? 'on' : 'off');
      guardButton.setAttribute('aria-label', guardButton.title);
      guardButton.style.color = next ? '#c4f5d0' : 'rgba(233,226,251,.4)';
    });
    if (!guardEnabled()) {
      guardButton.style.color = 'rgba(233,226,251,.4)';
      guardButton.title = 'Anti-close guard: off';
      guardButton.setAttribute('aria-label', guardButton.title);
    }
    bar.appendChild(guardButton);
    bar.appendChild(document.createElement('span')).className = 'sep';
    bar.appendChild(button('hide', 'Hide toolbar', function () { host.remove(); }));

    root.appendChild(style);
    root.appendChild(bar);
    (document.body || document.documentElement).appendChild(host);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }

  // --- transport carrier --------------------------------------------------
  // The service worker cannot open a WebSocket (browsers give workers none), so
  // the Epoxy transport lives in a SharedWorker that a page has to connect to.
  // Running it here means the tab you are browsing carries the transport.
  var self_ = self;
  var scriptSrc = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || '';
  var appRoot = scriptSrc ? new URL('./', scriptSrc).pathname : '/';
  var uvRoot = appRoot + 'uv/';

  function wispUrl() {
    var saved = '';
    try { saved = localStorage.getItem('veil.wisp') || ''; } catch (err) { /* storage blocked */ }
    var scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    if (!saved) return scheme + '//' + location.host + appRoot + 'wisp/';
    if (/^wss?:\/\//i.test(saved)) return saved;
    var host = saved.replace(/^\/+/, '');
    return scheme + '//' + host + (host.indexOf('/') === -1 ? '/wisp/' : '');
  }

  import(uvRoot + 'bare-mux.mjs')
    .then(function (mux) {
      var connection = new mux.BareMuxConnection(uvRoot + 'bare-mux-worker.js');
      return connection
        .setTransport(uvRoot + 'epoxy.mjs', [{ wisp: wispUrl(), wisp_v2: true }])
        .then(function () { self_.__veilTransport = wispUrl(); });
    })
    .catch(function (error) {
      console.error('[veil] transport failed on this page:', error);
      self_.__veilTransport = null;
    });
})();
