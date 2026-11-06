// Injected into every proxied page. Keeps runtime-created requests, navigations
// and network calls inside the proxy, and mounts a floating toolbar so you can
// get back home without a browser back button.
(function () {
  'use strict';

  var config = window.__PX_CONFIG || {};
  var PREFIX = config.prefix || '/__p/';
  var ORIGIN = config.origin || '';
  var ABSOLUTE = /^[a-z][a-z0-9+.-]*:/i;
  var SKIP = /^(data|blob|javascript|about|mailto|tel|magnet|sms):/i;

  function fix(url) {
    if (typeof url !== 'string') return url;
    var value = url.trim();
    if (!value || value.charAt(0) === '#' || SKIP.test(value)) return url;
    if (value.indexOf(PREFIX) === 0) return value;
    if (value.indexOf(location.origin + PREFIX) === 0) return value;
    if (/^\/\//.test(value)) return PREFIX + 'https:' + value;
    if (ABSOLUTE.test(value)) return PREFIX + value;
    if (value.charAt(0) === '/') return PREFIX + ORIGIN + value;
    return url;
  }

  // --- fetch -------------------------------------------------------------
  var nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function (input, init) {
      try {
        if (typeof input === 'string' || input instanceof URL) {
          input = fix(String(input));
        } else if (input && input.url) {
          var next = fix(input.url);
          if (next !== input.url) input = new Request(next, input);
        }
      } catch (err) {
        /* fall through with the original request */
      }
      return nativeFetch.call(this, input, init);
    };
  }

  // --- XMLHttpRequest ----------------------------------------------------
  var nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    try { args[1] = fix(String(url)); } catch (err) { /* keep original */ }
    return nativeOpen.apply(this, args);
  };

  // --- window.open -------------------------------------------------------
  var nativeWindowOpen = window.open;
  window.open = function (url) {
    var args = Array.prototype.slice.call(arguments);
    try { args[0] = fix(String(url)); } catch (err) { /* keep original */ }
    return nativeWindowOpen.apply(this, args);
  };

  // --- history -----------------------------------------------------------
  ['pushState', 'replaceState'].forEach(function (name) {
    var original = history[name];
    if (typeof original !== 'function') return;
    history[name] = function (state, title, url) {
      var args = Array.prototype.slice.call(arguments);
      try {
        if (typeof url === 'string') args[2] = fix(url);
      } catch (err) { /* keep original */ }
      return original.apply(this, args);
    };
  });

  // --- DOM attribute writes ---------------------------------------------
  var URL_PROPS = /^(src|href|action|poster|formaction|data-src|data-href)$/i;
  var nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    try {
      if (URL_PROPS.test(name) && typeof value === 'string') value = fix(value);
    } catch (err) { /* keep original */ }
    return nativeSetAttribute.call(this, name, value);
  };

  // --- links added at runtime -------------------------------------------
  document.addEventListener(
    'click',
    function (event) {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      var anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
      if (!anchor) return;
      var href = anchor.getAttribute('href');
      if (!href || href.charAt(0) === '#' || SKIP.test(href)) return;
      var next = fix(href);
      if (next === href) return;
      event.preventDefault();
      location.href = next;
    },
    true,
  );

  // --- anti-close guard --------------------------------------------------
  // Closing or reloading the tab raises the browser's own "Leave site?" prompt.
  // That dialog is native: the page cannot draw, reword or suppress it, it just
  // asks for confirmation via beforeunload. In-proxy navigation is exempt so
  // browsing does not prompt on every link.
  var GUARD_KEY = 'veil.anticlose';

  function guardEnabled() {
    try { return localStorage.getItem(GUARD_KEY) !== 'off'; } catch (err) { return true; }
  }

  function setGuard(enabled) {
    try { localStorage.setItem(GUARD_KEY, enabled ? 'on' : 'off'); } catch (err) { /* ignore */ }
  }

  var internalNav = false;
  window.__veilInternalNav = function () {
    internalNav = true;
    setTimeout(function () { internalNav = false; }, 4000);
  };

  window.addEventListener('beforeunload', function (event) {
    if (!guardEnabled() || internalNav) return undefined;
    // Chrome shows its own "Leave site? / Changes you made may not be saved."
    // panel for this; the string is ignored by every modern browser.
    event.preventDefault();
    event.returnValue = 'Leave site?';
    return 'Leave site?';
  });

  document.addEventListener(
    'click',
    function (event) {
      var anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
      if (!anchor) return;
      try {
        if (anchor.origin === location.origin) window.__veilInternalNav();
      } catch (err) { /* ignore */ }
    },
    true,
  );

  // --- floating toolbar --------------------------------------------------
  if (config.toolbar === false) return;

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
      window.__veilInternalNav();
      history.back();
    }));
    bar.appendChild(
      button('home', 'Veil home', function () {
        window.__veilInternalNav();
        location.href = '/';
      }),
    );
    bar.appendChild(
      button('reload', 'Reload', function () {
        window.__veilInternalNav();
        location.reload();
      }),
    );
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
})();
