// Veil debug overlay. Loaded on the landing page, on error pages and inside every
// proxied page, so one keyboard shortcut answers "what actually happened?" from
// anywhere. Everything renders in a shadow root: proxied sites cannot restyle it
// and it cannot restyle them.
(function () {
  'use strict';

  if (window.__veilDebug) return;

  var PREFIX = '/__p/';
  var host = null;
  var root = null;
  var timer = null;
  var lastState = null;
  var probeResult = '';

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
    };
  }

  function render() {
    if (!root) return;
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

    root.querySelector('.body').innerHTML =
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

    var probeButton = root.querySelector('.probe .go');
    var probeInput = root.querySelector('.probe input');
    probeButton.addEventListener('click', function () {
      runProbe(probeInput.value.trim());
    });
    probeInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') runProbe(probeInput.value.trim());
    });
  }

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
      .then(function (json) { lastState = json; render(); })
      .catch(function () { lastState = { ok: false }; render(); });
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
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483646;top:0;right:0;height:100%;';
    root = host.attachShadow({ mode: 'open' });

    root.innerHTML =
      '<style>' +
      ':host{all:initial}' +
      '.panel{display:flex;flex-direction:column;width:min(430px,100vw);height:100%;' +
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
      '.body{flex:1;overflow:auto;padding:8px 16px 24px}' +
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
      '</style>' +
      '<div class="panel">' +
      '<header><span class="dot"></span><h2>Veil debug</h2><span class="spacer"></span>' +
      '<button type="button" class="copy">Copy report</button>' +
      '<button type="button" class="close">Close</button></header>' +
      '<div class="body"></div>' +
      '<div class="actions">' +
      '<button type="button" class="reload">Reload page</button>' +
      '<button type="button" class="home">Veil home</button>' +
      '<button type="button" class="clear">Clear log</button>' +
      '</div></div>';

    root.querySelector('.close').addEventListener('click', close);
    root.querySelector('.copy').addEventListener('click', copyReport);
    root.querySelector('.reload').addEventListener('click', function () { location.reload(); });
    root.querySelector('.clear').addEventListener('click', clear);
    root.querySelector('.home').addEventListener('click', function () { location.href = '/'; });

    document.documentElement.appendChild(host);
    refresh();
    timer = setInterval(refresh, 2000);
  }

  function close() {
    if (timer) clearInterval(timer);
    timer = null;
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
