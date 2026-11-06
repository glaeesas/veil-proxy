// Veil debug overlay. Loaded on the landing page, on error pages and inside every
// proxied page, so one keyboard shortcut answers "what actually happened?" from
// anywhere. Everything renders in a shadow root: proxied sites cannot restyle it
// and it cannot restyle them.
//
// It is injected synchronously, before the page's own scripts, so the console tab
// catches messages from the very first line the site executes.
(function () {
  'use strict';

  if (window.__veilDebug) return;

  var PREFIX = '/__p/';
  var host = null;
  var root = null;
  var timer = null;
  var lastState = null;
  var probeResult = '';
  var activeTab = 'overview';

  // ===== console capture =========================================================

  var LOG_LIMIT = 400;
  var logs = [];
  var nextId = 1;
  var onEntry = null; // wired up by the console pane when it is on screen
  var onUpdate = null;

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function stamp() {
    var d = new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function truncate(text, max) {
    max = max || 1600;
    return text.length > max ? text.slice(0, max) + ' …(' + text.length + ' chars)' : text;
  }

  function inspect(value, depth, seen) {
    depth = depth || 0;
    seen = seen || [];

    if (value === null) return 'null';
    var type = typeof value;
    if (type === 'undefined') return 'undefined';
    if (type === 'string') return depth === 0 ? value : JSON.stringify(value);
    if (type === 'number' || type === 'boolean' || type === 'bigint') return String(value);
    if (type === 'symbol') return String(value);
    if (type === 'function') return 'ƒ ' + (value.name || 'anonymous') + '()';

    try {
      if (value instanceof Error) return value.stack || value.name + ': ' + value.message;
    } catch (err) { /* cross-realm */ }

    try {
      if (typeof Node !== 'undefined' && value instanceof Node) {
        if (value.nodeType === 1) {
          var cls = typeof value.className === 'string' && value.className.trim()
            ? '.' + value.className.trim().split(/\s+/).join('.')
            : '';
          return '<' + String(value.tagName).toLowerCase() + (value.id ? '#' + value.id : '') + cls + '>';
        }
        return '#' + value.nodeName;
      }
    } catch (err) { /* cross-realm */ }

    if (value === window) return 'Window';
    if (seen.indexOf(value) !== -1) return '[Circular]';
    if (depth >= 3) return Array.isArray(value) ? '[…]' : '{…}';

    seen = seen.concat([value]);

    try {
      if (value instanceof Date) return value.toISOString();
      if (value instanceof RegExp) return String(value);
    } catch (err) { /* cross-realm */ }

    var parts = [];
    var i;

    if (Array.isArray(value)) {
      for (i = 0; i < value.length && i < 40; i += 1) parts.push(inspect(value[i], depth + 1, seen));
      if (value.length > 40) parts.push('…' + (value.length - 40) + ' more');
      return '[' + parts.join(', ') + ']';
    }

    if (typeof value.then === 'function' && typeof value.catch === 'function') return 'Promise {…}';

    var keys;
    try {
      keys = Object.keys(value);
    } catch (err) {
      return String(value);
    }
    for (i = 0; i < keys.length && i < 30; i += 1) {
      var key = keys[i];
      var rendered;
      try {
        rendered = inspect(value[key], depth + 1, seen);
      } catch (err) {
        rendered = '[getter threw: ' + err.message + ']';
      }
      parts.push(/^[A-Za-z_$][\w$]*$/.test(key) ? key + ': ' + rendered : '"' + key + '": ' + rendered);
    }
    if (keys.length > 30) parts.push('…' + (keys.length - 30) + ' more');

    var ctor = '';
    try {
      if (value.constructor && value.constructor.name && value.constructor.name !== 'Object') {
        ctor = value.constructor.name + ' ';
      }
    } catch (err) { /* ignore */ }

    return ctor + '{' + parts.join(', ') + '}';
  }

  function push(level, text) {
    var entry = { id: nextId, level: level, at: stamp(), text: truncate(String(text), 1600) };
    nextId += 1;
    logs.push(entry);
    if (logs.length > LOG_LIMIT) logs.splice(0, logs.length - LOG_LIMIT);
    if (onEntry) {
      try { onEntry(entry); } catch (err) { /* never break the page */ }
    }
    return entry.id;
  }

  function updateEntry(id, patch) {
    for (var i = logs.length - 1; i >= 0; i -= 1) {
      if (logs[i].id === id) {
        logs[i].level = patch.level || logs[i].level;
        logs[i].text = truncate(patch.text === undefined ? logs[i].text : patch.text, 1600);
        if (onUpdate) {
          try { onUpdate(logs[i]); } catch (err) { /* ignore */ }
        }
        return;
      }
    }
  }

  function formatArgs(args) {
    var parts = [];
    for (var i = 0; i < args.length; i += 1) {
      try {
        parts.push(inspect(args[i], 0, []));
      } catch (err) {
        parts.push('[uninspectable]');
      }
    }
    return parts.join(' ');
  }

  // console.* is wrapped, never replaced: the real DevTools console keeps working.
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    var native = console[level];
    if (typeof native !== 'function') return;
    console[level] = function () {
      try {
        push(level, formatArgs(Array.prototype.slice.call(arguments)));
      } catch (err) { /* ignore */ }
      return native.apply(console, arguments);
    };
  });

  window.addEventListener(
    'error',
    function (event) {
      try {
        if (event && event.message !== undefined && event.filename !== undefined) {
          var detail = event.error ? inspect(event.error, 0, []) : String(event.message);
          var where = event.filename
            ? '\n    at ' + event.filename + ':' + event.lineno + ':' + event.colno
            : '';
          push('error', 'Uncaught ' + detail + where);
        }
      } catch (err) { /* ignore */ }
    },
    true,
  );

  window.addEventListener('unhandledrejection', function (event) {
    try {
      push('error', 'Unhandled promise rejection: ' + inspect(event.reason, 0, []));
    } catch (err) { /* ignore */ }
  });

  // Only failures are recorded, so a busy site does not drown the log.
  var INTERNAL = /\/__debug\/|\/debug\.js|\/shim\.js/;

  function watchFetch() {
    var native = window.fetch;
    if (typeof native !== 'function') return;
    window.fetch = function (input, init) {
      var url = '';
      var method = 'GET';
      try {
        if (typeof input === 'string') url = input;
        else if (input && input.url) url = input.url;
        else url = String(input);
        method = (init && init.method) || (input && input.method) || 'GET';
      } catch (err) { /* ignore */ }
      if (INTERNAL.test(url)) return native.apply(this, arguments);
      var started = performance.now();
      var pending = native.apply(this, arguments);
      if (!pending || typeof pending.then !== 'function') return pending;
      return pending.then(
        function (res) {
          if (!res.ok) {
            push('net', method.toUpperCase() + ' ' + url + ' → ' + res.status + ' ' + (res.statusText || ''));
          }
          return res;
        },
        function (err) {
          push('net', method.toUpperCase() + ' ' + url + ' failed: ' + inspect(err, 0, []));
          throw err;
        },
      );
    };
  }

  function watchXhr() {
    var native = XMLHttpRequest.prototype.open;
    if (typeof native !== 'function') return;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        var self = this;
        if (!self.__veilWatched) {
          self.__veilWatched = true;
          self.addEventListener('loadend', function () {
            if (self.status >= 400) {
              push('net', String(self.__veilMethod || 'GET').toUpperCase() + ' ' + self.__veilUrl + ' → ' + self.status);
            }
          });
        }
        self.__veilMethod = method;
        self.__veilUrl = String(url);
      } catch (err) { /* ignore */ }
      return native.apply(this, arguments);
    };
  }

  try { watchFetch(); } catch (err) { /* ignore */ }
  try { watchXhr(); } catch (err) { /* ignore */ }

  // ===== helpers =================================================================

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function encode(url) {
    var bytes = new TextEncoder().encode(url);
    var binary = '';
    for (var i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // The address bar carries an opaque path; decode it so the panel can name the
  // site that is actually loaded.
  function currentTarget() {
    var path = location.pathname;
    if (path.indexOf(PREFIX) !== 0) return null;
    var rest = path.slice(PREFIX.length);
    var slash = rest.indexOf('/');
    var head = slash === -1 ? rest : rest.slice(0, slash);
    var tail = slash === -1 ? '' : rest.slice(slash + 1);
    try {
      var padded = head.replace(/-/g, '+').replace(/_/g, '/');
      while (padded.length % 4) padded += '=';
      var binary = atob(padded);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      var decoded = new TextDecoder().decode(bytes);
      if (!/^https?:\/\//i.test(decoded)) return null;
      var url = tail ? new URL(tail, decoded).href : decoded;
      return url + location.search;
    } catch (err) {
      return null;
    }
  }

  function patchStatus() {
    var checks = [];
    checks.push(['fetch', !/\[native code\]/.test(String(window.fetch))]);
    checks.push(['XHR', !/\[native code\]/.test(String(XMLHttpRequest.prototype.open))]);
    checks.push(['history', Boolean(window.__PX_CONFIG)]);
    checks.push(['nav-api', !!(window.navigation && /\[native code\]/.test(String(navigation.navigate)) === false)]);
    return checks;
  }

  function settings() {
    var out = {};
    try {
      for (var i = 0; i < localStorage.length; i += 1) {
        var key = localStorage.key(i);
        if (key && key.indexOf('veil.') === 0) out[key] = localStorage.getItem(key);
      }
    } catch (err) {
      out.error = 'localStorage unavailable';
    }
    return out;
  }

  function row(label, value) {
    return (
      '<div class="row"><span class="k">' + esc(label) + '</span>' +
      '<span class="v">' + (value === null || value === undefined || value === '' ? '<i>—</i>' : esc(value)) +
      '</span></div>'
    );
  }

  function buildReport() {
    var state = lastState || {};
    var target = currentTarget();
    return {
      generatedAt: new Date().toISOString(),
      page: {
        href: location.href,
        title: document.title,
        target: target,
        viewport: window.innerWidth + 'x' + window.innerHeight,
        userAgent: navigator.userAgent,
        online: navigator.onLine,
      },
      patches: patchStatus().reduce(function (acc, pair) {
        acc[pair[0]] = pair[1];
        return acc;
      }, {}),
      settings: settings(),
      server: state.ok
        ? {
            node: state.node,
            platform: state.platform,
            port: state.port,
            host: state.host,
            uptimeSec: state.uptimeSec,
            memoryMb: state.memoryMb,
            stats: state.stats,
          }
        : { error: 'server state unavailable' },
      recentRequests: (state.log || []).slice(0, 15),
      console: logs.slice(-80).map(function (entry) {
        return entry.at + ' ' + entry.level + ' ' + entry.text;
      }),
    };
  }

  // ===== overview tab ============================================================

  function renderOverview() {
    if (!root) return;
    var pane = root.querySelector('.pane.overview');
    if (!pane) return;
    // Never wipe what the visitor is typing.
    if (pane.contains(document.activeElement)) return;

    var state = lastState;
    var target = currentTarget();
    var server = state && state.ok ? state : null;
    var log = (server && server.log) || [];

    var match = null;
    if (target) {
      for (var i = 0; i < log.length; i += 1) {
        if (log[i].target === target) { match = log[i]; break; }
      }
    }

    var patched = patchStatus()
      .map(function (pair) {
        return '<span class="chip ' + (pair[1] ? 'on' : 'off') + '">' + esc(pair[0]) + '</span>';
      })
      .join('');
    // Veil's own pages never load the shim, so four red chips would look like a
    // fault rather than a fact.
    var patches = target
      ? patched
      : '<p class="muted">Not a proxied page, so the shim is not injected here. Open a site through Veil to see patch status.</p>';

    var store = settings();
    var storeRows = Object.keys(store)
      .map(function (key) { return row(key, store[key]); })
      .join('');

    var rows = log
      .slice(0, 12)
      .map(function (item) {
        var status = item.status || '';
        var cls = status >= 400 || item.error ? 'bad' : 'ok';
        return (
          '<div class="logrow ' + cls + '">' +
          '<span class="s">' + esc(status) + '</span>' +
          '<span class="ms">' + esc(item.ms) + 'ms</span>' +
          '<span class="m">' + esc(item.method || 'GET') + '</span>' +
          '<span class="t" title="' + esc(item.target || '') + '">' + esc(item.target || item.error || '—') + '</span>' +
          '</div>'
        );
      })
      .join('');

    pane.innerHTML =
      '<section>' +
      '<h3>This page</h3>' +
      row('Address', location.pathname + location.search) +
      row('Proxied target', target || 'not proxied (a Veil page)') +
      row('Title', document.title) +
      '</section>' +

      '<section>' +
      '<h3>Last request for this page</h3>' +
      (match
        ? row('Status', match.status) +
          row('Took', match.ms + ' ms') +
          row('Size', match.bytes ? match.bytes + ' bytes' : null) +
          row('Upstream', match.upstream) +
          row('Trace', match.trace) +
          row('Error', match.error)
        : '<p class="muted">No matching request in the server log. It may have scrolled out, or been served from another process.</p>') +
      '</section>' +

      '<section>' +
      '<h3>Server</h3>' +
      (server
        ? row('Node', server.node) +
          row('Platform', server.platform) +
          row('Listening', server.host + ':' + server.port) +
          row('Uptime', server.uptimeSec + ' s') +
          row('Memory', server.memoryMb + ' MB') +
          row('Requests seen', server.stats ? server.stats.recorded : null)
        : '<p class="muted">Could not read <code>/__debug/state</code>. The server may be down.</p>') +
      '</section>' +

      '<section>' +
      '<h3>Shim patches</h3>' +
      '<div class="chips">' + patches + '</div>' +
      '</section>' +

      '<section>' +
      '<h3>Settings</h3>' +
      (storeRows || '<p class="muted">Nothing stored yet.</p>') +
      '</section>' +

      '<section>' +
      '<h3>Recent proxy requests</h3>' +
      (rows || '<p class="muted">No proxied requests recorded yet.</p>') +
      '</section>' +

      '<section>' +
      '<h3>Probe a URL</h3>' +
      '<div class="probe">' +
      '<input class="field" type="text" placeholder="https://example.com" spellcheck="false">' +
      '<button type="button" class="go">Test</button>' +
      '</div>' +
      '<p class="muted" id="probe-result">' + esc(probeResult || 'Sends the URL through the proxy and reports status and timing.') + '</p>' +
      '</section>' +

      '<p class="muted foot">Trace IDs match the error screen. Copy report puts all of this on the clipboard.</p>';

    var probeButton = pane.querySelector('.probe .go');
    var probeInput = pane.querySelector('.probe input');
    probeButton.addEventListener('click', function () {
      runProbe(probeInput.value.trim());
    });
    probeInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') runProbe(probeInput.value.trim());
    });
  }

  // ===== console tab =============================================================

  var filterText = '';
  var historyList = [];
  var historyIndex = 0;

  function matches(entry) {
    if (!filterText) return true;
    return entry.text.toLowerCase().indexOf(filterText) !== -1;
  }

  function lineHtml(entry) {
    return (
      '<div class="line ' + esc(entry.level) + '" data-id="' + entry.id + '">' +
      '<span class="lt">' + esc(entry.at) + '</span>' +
      '<span class="lm">' + esc(entry.text) + '</span>' +
      '</div>'
    );
  }

  function consoleLogEl() {
    return root ? root.querySelector('.clog') : null;
  }

  function atBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  function scrollConsole() {
    var el = consoleLogEl();
    if (el) el.scrollTop = el.scrollHeight;
  }

  function renderConsole() {
    var el = consoleLogEl();
    if (!el) return;
    var shown = logs.filter(matches);
    el.innerHTML = shown.length
      ? shown.map(lineHtml).join('')
      : '<p class="muted" style="padding:8px 0">No console messages yet. Anything this page logs, throws or fails to fetch shows up here.</p>';
    scrollConsole();
    updateBadge();
  }

  function appendConsoleEntry(entry) {
    var el = consoleLogEl();
    if (!el || !matches(entry)) {
      updateBadge();
      return;
    }
    var stick = atBottom(el);
    var empty = el.querySelector('.muted');
    if (empty) el.innerHTML = '';
    el.insertAdjacentHTML('beforeend', lineHtml(entry));
    while (el.children.length > LOG_LIMIT) el.removeChild(el.firstElementChild);
    if (stick) scrollConsole();
    updateBadge();
  }

  function replaceConsoleEntry(entry) {
    var el = consoleLogEl();
    if (!el || !matches(entry)) return;
    var node = el.querySelector('[data-id="' + entry.id + '"]');
    if (node) {
      node.className = 'line ' + entry.level;
      var text = node.querySelector('.lm');
      if (text) text.textContent = entry.text;
    }
  }

  function errorCount() {
    var count = 0;
    for (var i = 0; i < logs.length; i += 1) if (logs[i].level === 'error') count += 1;
    return count;
  }

  function updateBadge() {
    if (!root) return;
    var badge = root.querySelector('.badge');
    if (!badge) return;
    var count = errorCount();
    badge.hidden = count === 0;
    badge.textContent = String(count);
  }

  function evaluate(code) {
    code = String(code || '').trim();
    if (!code) return;
    push('input', code);
    historyList.push(code);
    if (historyList.length > 100) historyList.shift();
    historyIndex = historyList.length;

    var result;
    try {
      try {
        result = new Function('return (' + code + '\n)').call(window);
      } catch (err) {
        if (err instanceof SyntaxError) result = new Function(code).call(window);
        else throw err;
      }
    } catch (err) {
      push('error', inspect(err, 0, []));
      return;
    }

    if (result && typeof result.then === 'function' && typeof result.catch === 'function') {
      var id = push('result', 'Promise {<pending>}');
      result.then(
        function (value) {
          updateEntry(id, { level: 'result', text: 'Promise resolved: ' + inspect(value, 0, []) });
        },
        function (err) {
          updateEntry(id, { level: 'error', text: 'Promise rejected: ' + inspect(err, 0, []) });
        },
      );
      return;
    }

    push('result', result === undefined ? 'undefined' : inspect(result, 0, []));
  }

  function setTab(name) {
    if (!root) return;
    activeTab = name;
    var tabs = root.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i += 1) {
      var on = tabs[i].getAttribute('data-tab') === name;
      tabs[i].classList.toggle('on', on);
    }
    root.querySelector('.pane.overview').hidden = name !== 'overview';
    root.querySelector('.pane.console').hidden = name !== 'console';

    if (name === 'console') {
      onEntry = function (entry) {
        if (activeTab === 'console') appendConsoleEntry(entry);
      };
      onUpdate = function (entry) {
        if (activeTab === 'console') replaceConsoleEntry(entry);
      };
      renderConsole();
      var input = root.querySelector('.cinput');
      if (input) input.focus();
    } else {
      onEntry = null;
      onUpdate = null;
    }
  }

  // ===== panel ===================================================================

  function runProbe(value) {
    var out = root.querySelector('#probe-result');
    if (!value) { out.textContent = 'Enter a full URL, including https://'; return; }
    var url;
    try {
      url = new URL(value);
    } catch (err) {
      out.textContent = 'That is not a valid URL.';
      return;
    }
    out.textContent = 'Testing ' + url.href + ' …';
    var started = performance.now();
    fetch(PREFIX + encode(url.href), { method: 'HEAD', cache: 'no-store' })
      .then(function (res) {
        var ms = Math.round(performance.now() - started);
        probeResult = res.status + ' in ' + ms + ' ms (' + res.headers.get('content-type') + ')';
        out.textContent = probeResult;
        refresh();
      })
      .catch(function (err) {
        probeResult = 'Probe failed: ' + err;
        out.textContent = probeResult;
      });
  }

  function refresh() {
    fetch('/__debug/state', { cache: 'no-store' })
      .then(function (res) { return res.json(); })
      .then(function (json) { lastState = json; renderOverview(); })
      .catch(function () { lastState = { ok: false }; renderOverview(); });
  }

  function copyReport() {
    var text = JSON.stringify(buildReport(), null, 2);
    var done = function () {
      var button = root.querySelector('.copy');
      if (button) {
        button.textContent = 'Copied';
        setTimeout(function () { button.textContent = 'Copy report'; }, 1400);
      }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { window.prompt('Copy report', text); });
    } else {
      window.prompt('Copy report', text);
    }
  }

  function clear() {
    fetch('/__debug/state?clear=1', { cache: 'no-store' }).then(refresh, refresh);
  }

  function open() {
    if (host) { refresh(); return; }
    host = document.createElement('div');
    host.id = '__veil_debug';
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:0;right:0;height:100%;';
    root = host.attachShadow({ mode: 'open' });

    root.innerHTML =
      '<style>' +
      ':host{all:initial}' +
      // 100vw includes the scrollbar, which pushed the panel off-screen on
      // narrow viewports; the width must stay inside the initial containing block.
      '.panel{display:flex;flex-direction:column;width:430px;max-width:calc(100vw - 16px);height:100%;' +
      'background:#0d0a16;border-left:1px solid rgba(255,255,255,.14);' +
      'box-shadow:-24px 0 60px rgba(0,0,0,.5);color:#eae2fb;' +
      'font:400 12.5px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
      'header{display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.1)}' +
      'header h2{margin:0;font-size:14px;font-weight:650;letter-spacing:-.01em}' +
      'header .dot{width:7px;height:7px;border-radius:99px;background:#34d399;box-shadow:0 0 10px #34d399}' +
      'header .spacer{flex:1}' +
      'button{all:unset;cursor:pointer;padding:6px 11px;border-radius:8px;font-size:11.5px;font-weight:600;' +
      'background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);color:#eae2fb}' +
      'button:hover{background:rgba(168,85,247,.25);border-color:rgba(168,85,247,.5)}' +
      'button:focus-visible{outline:2px solid #a855f7;outline-offset:1px}' +
      '.tabs{display:flex;gap:2px;padding:8px 12px 0;border-bottom:1px solid rgba(255,255,255,.1)}' +
      '.tab{padding:7px 12px;border:none;border-radius:8px 8px 0 0;background:transparent;color:#8d81ab;' +
      'border-bottom:2px solid transparent;font-weight:600}' +
      '.tab:hover{background:rgba(255,255,255,.05);border-color:transparent;color:#c9bde8}' +
      '.tab.on{color:#f0e9ff;background:rgba(168,85,247,.14);border-bottom-color:#a855f7}' +
      '.badge{margin-left:6px;padding:0 5px;border-radius:99px;background:#f87171;color:#1c0b12;font-size:10px;font-weight:700}' +
      '.body{flex:1;min-height:0;display:flex}' +
      '.pane{flex:1;min-height:0}' +
      '.pane[hidden]{display:none}' +
      '.pane.overview{overflow:auto;padding:8px 16px 24px}' +
      'section{margin:14px 0 0}' +
      'h3{margin:0 0 8px;font-size:10.5px;text-transform:uppercase;letter-spacing:.13em;color:#8d81ab;font-weight:650}' +
      '.row{display:grid;grid-template-columns:110px 1fr;gap:8px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.05)}' +
      '.k{color:#8d81ab;font-size:11px}' +
      '.v{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;word-break:break-all;color:#f0e9ff}' +
      '.v i{color:#5b5372;font-style:normal}' +
      '.chips{display:flex;flex-wrap:wrap;gap:6px}' +
      '.chip{font-size:11px;padding:4px 9px;border-radius:99px;border:1px solid rgba(255,255,255,.16);color:#a99fc4}' +
      '.chip.on{color:#c6f6d5;border-color:rgba(52,211,153,.5);background:rgba(52,211,153,.12)}' +
      '.chip.off{color:#fca5a5;border-color:rgba(248,113,113,.45);background:rgba(248,113,113,.1)}' +
      '.logrow{display:grid;grid-template-columns:38px 52px 42px 1fr;gap:6px;padding:4px 0;' +
      'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;border-bottom:1px solid rgba(255,255,255,.05)}' +
      '.logrow.ok .s{color:#6ee7b7}.logrow.bad .s{color:#fca5a5}' +
      '.logrow .ms,.logrow .m{color:#8d81ab}' +
      '.logrow .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#d9cff0}' +
      '.muted{color:#8d81ab;font-size:11.5px;margin:6px 0 0;line-height:1.55}' +
      '.muted code{font-family:ui-monospace,Menlo,monospace;background:rgba(255,255,255,.07);padding:1px 5px;border-radius:5px}' +
      '.probe{display:flex;gap:6px}' +
      '.field{flex:1;min-width:0;padding:8px 10px;border-radius:8px;background:rgba(255,255,255,.05);' +
      'border:1px solid rgba(255,255,255,.15);color:#f0e9ff;font:400 12px ui-monospace,Menlo,monospace;outline:none}' +
      '.field:focus-visible{border-color:#a855f7}' +
      '.foot{margin-top:18px}' +
      '.actions{display:flex;gap:6px;padding:10px 16px;border-top:1px solid rgba(255,255,255,.1)}' +
      '.pane.console{display:flex;flex-direction:column;padding:0;overflow:hidden}' +
      '.ctop{display:flex;gap:6px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.08)}' +
      '.filter{flex:1;min-width:0;padding:7px 10px;border-radius:8px;background:rgba(255,255,255,.05);' +
      'border:1px solid rgba(255,255,255,.14);color:#f0e9ff;font:400 11.5px ui-monospace,Menlo,monospace;outline:none}' +
      '.filter:focus-visible{border-color:#a855f7}' +
      '.clog{flex:1;min-height:0;overflow:auto;padding:8px 12px;' +
      'font:400 11.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}' +
      '.line{display:grid;grid-template-columns:60px 1fr;gap:8px;padding:2px 0;border-bottom:1px solid rgba(255,255,255,.045)}' +
      '.line .lt{color:#5b5372;font-size:10.5px;padding-top:2px}' +
      '.line .lm{white-space:pre-wrap;word-break:break-word;color:#e2d8f7}' +
      '.line.warn .lm{color:#fcd34d}' +
      '.line.error .lm{color:#fca5a5}' +
      '.line.net .lm{color:#93c5fd}' +
      '.line.net{background:rgba(59,130,246,.06)}' +
      '.line.input{background:rgba(168,85,247,.12)}' +
      '.line.input .lm{color:#f0e9ff}' +
      '.line.input .lt{color:#a855f7}' +
      '.line.result .lm{color:#a7f3d0}' +
      '.line.result .lt{color:#34d399}' +
      '.cform{display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid rgba(255,255,255,.1);' +
      'background:rgba(255,255,255,.02)}' +
      '.prompt{color:#a855f7;font-family:ui-monospace,Menlo,monospace;font-size:13px;font-weight:700}' +
      '.cinput{flex:1;min-width:0;background:transparent;border:none;outline:none;color:#f0e9ff;' +
      'font:400 12px ui-monospace,Menlo,monospace;padding:4px 0}' +
      '.cinput::placeholder{color:#5b5372}' +
      '</style>' +
      '<div class="panel">' +
      '<header><span class="dot"></span><h2>Veil debug</h2><span class="spacer"></span>' +
      '<button type="button" class="copy">Copy report</button>' +
      '<button type="button" class="close">Close</button></header>' +
      '<nav class="tabs">' +
      '<button type="button" class="tab on" data-tab="overview">Overview</button>' +
      '<button type="button" class="tab" data-tab="console">Console<span class="badge" hidden>0</span></button>' +
      '</nav>' +
      '<div class="body">' +
      '<div class="pane overview"></div>' +
      '<div class="pane console" hidden>' +
      '<div class="ctop">' +
      '<input class="filter" type="text" placeholder="Filter messages" spellcheck="false">' +
      '<button type="button" class="clearc">Clear</button>' +
      '</div>' +
      '<div class="clog"></div>' +
      '<form class="cform">' +
      '<span class="prompt">&gt;</span>' +
      '<input class="cinput" type="text" placeholder="Evaluate JavaScript in this page" spellcheck="false" autocomplete="off">' +
      '</form>' +
      '</div>' +
      '</div>' +
      '<div class="actions">' +
      '<button type="button" class="reload">Reload page</button>' +
      '<button type="button" class="home">Veil home</button>' +
      '<button type="button" class="clear">Clear server log</button>' +
      '</div></div>';

    root.querySelector('.close').addEventListener('click', close);
    root.querySelector('.copy').addEventListener('click', copyReport);
    root.querySelector('.reload').addEventListener('click', function () { location.reload(); });
    root.querySelector('.clear').addEventListener('click', clear);
    root.querySelector('.home').addEventListener('click', function () { location.href = '/'; });

    var tabs = root.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i += 1) {
      tabs[i].addEventListener('click', function (event) {
        setTab(event.currentTarget.getAttribute('data-tab'));
      });
    }

    var filterInput = root.querySelector('.filter');
    filterInput.addEventListener('input', function () {
      filterText = filterInput.value.trim().toLowerCase();
      renderConsole();
    });

    root.querySelector('.clearc').addEventListener('click', function () {
      logs.length = 0;
      renderConsole();
    });

    var form = root.querySelector('.cform');
    var input = root.querySelector('.cinput');
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var code = input.value;
      input.value = '';
      evaluate(code);
    });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowUp') {
        if (!historyList.length) return;
        event.preventDefault();
        historyIndex = Math.max(0, historyIndex - 1);
        input.value = historyList[historyIndex] || '';
      } else if (event.key === 'ArrowDown') {
        if (!historyList.length) return;
        event.preventDefault();
        historyIndex = Math.min(historyList.length, historyIndex + 1);
        input.value = historyList[historyIndex] || '';
      } else if (event.key === 'l' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        logs.length = 0;
        renderConsole();
      }
    });

    document.documentElement.appendChild(host);
    setTab(activeTab);
    refresh();
    timer = setInterval(refresh, 2000);
  }

  function close() {
    if (timer) clearInterval(timer);
    timer = null;
    onEntry = null;
    onUpdate = null;
    if (host) host.remove();
    host = null;
    root = null;
  }

  function toggle() {
    if (host) close();
    else open();
  }

  window.__veilDebug = {
    open: open,
    close: close,
    toggle: toggle,
    refresh: refresh,
    report: buildReport,
    console: {
      entries: function () { return logs.slice(); },
      run: evaluate,
      clear: function () { logs.length = 0; renderConsole(); },
    },
  };

  document.addEventListener(
    'keydown',
    function (event) {
      var modifier = event.ctrlKey || event.metaKey;
      if (!modifier || !event.altKey) return;
      if (String(event.key).toLowerCase() !== 'd') return;
      event.preventDefault();
      toggle();
    },
    true,
  );

  if (/[?&]debug=1\b/.test(location.search)) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', open, { once: true });
    } else {
      open();
    }
  }
})();
