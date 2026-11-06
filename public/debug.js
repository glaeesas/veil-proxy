// Veil DevTools. Loaded on the landing page, on error pages and inside every proxied
// page: one shortcut, and the page in front of you becomes inspectable — its DOM, its
// stylesheets, its network traffic, its storage, its scripts, and its console.
//
// Everything renders in a shadow root, so neither the site nor Veil's own UI can
// restyle it. It is injected synchronously, ahead of the page's own scripts, so the
// console and network tabs record from the first line the site executes.
(function () {
  'use strict';

  if (window.__veilDebug) return;

  var PREFIX = '/__p/';
  var INTERNAL = /\/__debug\/|\/debug\.js|\/shim\.js/;
  var LOG_LIMIT = 400;
  var NET_LIMIT = 500;
  var PREFS_KEY = 'veil.devtools';

  var host = null;
  var root = null;
  var timer = null;
  var lastState = null;
  var probeResult = '';
  var activeTab = 'console';
  var prefs = { logs: true, net: true, autoOpen: false };

  loadPrefs();

  function loadPrefs() {
    try {
      var raw = localStorage.getItem(PREFS_KEY);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      ['logs', 'net', 'autoOpen'].forEach(function (key) {
        if (typeof parsed[key] === 'boolean') prefs[key] = parsed[key];
      });
    } catch (err) { /* private mode, or garbage in the key */ }
  }

  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (err) { /* ignore */ }
  }

  // ===== console capture =========================================================

  var logs = [];
  var nextId = 1;
  var onEntry = null;
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
      if (prefs.logs) {
        try {
          push(level, formatArgs(Array.prototype.slice.call(arguments)));
        } catch (err) { /* ignore */ }
      }
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
          if (prefs.logs) push('error', 'Uncaught ' + detail + where);
          if (prefs.autoOpen && !host) {
            open();
            setTab('console');
          }
        }
      } catch (err) { /* ignore */ }
    },
    true,
  );

  window.addEventListener('unhandledrejection', function (event) {
    try {
      if (prefs.logs) push('error', 'Unhandled promise rejection: ' + inspect(event.reason, 0, []));
    } catch (err) { /* ignore */ }
  });

  // ===== network capture =========================================================

  var net = [];
  var nextNet = 1;
  var netTimer = null;

  function abs(url) {
    try { return new URL(String(url), location.href).href; } catch (err) { return String(url); }
  }

  function scheduleNet() {
    if (netTimer) return;
    netTimer = setTimeout(function () {
      netTimer = null;
      if (activeTab === 'network') renderNetwork();
    }, 120);
  }

  function addNet(item) {
    item.id = nextNet;
    nextNet += 1;
    item.at = Date.now();
    if (!item.headers) item.headers = null;
    net.push(item);
    if (net.length > NET_LIMIT) net.splice(0, net.length - NET_LIMIT);
    scheduleNet();
    return item;
  }

  function headerList(headers) {
    var out = [];
    if (!headers) return out;
    try {
      if (headers.forEach) {
        headers.forEach(function (value, key) { out.push([key, value]); });
        return out;
      }
    } catch (err) { /* ignore */ }
    try {
      for (var i = 0; i < headers.length; i += 1) out.push([headers[i][0], headers[i][1]]);
    } catch (err) { /* ignore */ }
    return out;
  }

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
      if (INTERNAL.test(url) || !prefs.net) return native.apply(this, arguments);

      var record = addNet({
        kind: 'fetch',
        method: String(method).toUpperCase(),
        url: abs(url),
        status: 0,
        ms: 0,
        size: 0,
        type: 'fetch',
        done: false,
        headers: null,
      });
      var started = performance.now();

      var pending = native.apply(this, arguments);
      if (!pending || typeof pending.then !== 'function') return pending;

      return pending.then(
        function (res) {
          record.status = res.status;
          record.ms = Math.round(performance.now() - started);
          record.done = true;
          record.headers = headerList(res.headers);
          try {
            var len = res.headers.get('content-length');
            record.size = len ? Number(len) : 0;
          } catch (err) { /* ignore */ }
          scheduleNet();
          if (prefs.logs && !res.ok) {
            push('net', record.method + ' ' + record.url + ' → ' + res.status + ' ' + (res.statusText || ''));
          }
          return res;
        },
        function (err) {
          record.ms = Math.round(performance.now() - started);
          record.done = true;
          record.failed = String((err && err.message) || err);
          scheduleNet();
          if (prefs.logs) push('net', record.method + ' ' + record.url + ' failed: ' + inspect(err, 0, []));
          throw err;
        },
      );
    };
  }

  function watchXhr() {
    var nativeOpen = XMLHttpRequest.prototype.open;
    var nativeSend = XMLHttpRequest.prototype.send;
    if (typeof nativeOpen !== 'function') return;

    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        this.__veilMethod = String(method || 'GET').toUpperCase();
        this.__veilUrl = abs(url);
      } catch (err) { /* ignore */ }
      return nativeOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function () {
      try {
        var self = this;
        if (prefs.net && !INTERNAL.test(String(self.__veilUrl))) {
          var record = addNet({
            kind: 'xhr',
            method: self.__veilMethod || 'GET',
            url: self.__veilUrl || '',
            status: 0,
            ms: 0,
            size: 0,
            type: 'xhr',
            done: false,
            headers: null,
          });
          var started = performance.now();
          self.addEventListener('loadend', function () {
            record.ms = Math.round(performance.now() - started);
            record.done = true;
            try { record.status = self.status; } catch (err) { /* ignore */ }
            try {
              var len = self.getResponseHeader('content-length');
              record.size = len ? Number(len) : 0;
              var type = self.getResponseHeader('content-type') || '';
              record.headers = type ? [['content-type', type]] : null;
            } catch (err) { /* ignore */ }
            scheduleNet();
            if (prefs.logs && record.status >= 400) {
              push('net', record.method + ' ' + record.url + ' → ' + record.status);
            }
          });
        }
      } catch (err) { /* ignore */ }
      return nativeSend.apply(this, arguments);
    };
  }

  function addResource(entry) {
    if (!prefs.net) return;
    if (INTERNAL.test(entry.name)) return;
    var recent = Math.max(0, net.length - 40);
    for (var i = net.length - 1; i >= recent; i -= 1) {
      if (net[i].url === entry.name || net[i].url === abs(entry.name)) return;
    }
    addNet({
      kind: 'resource',
      method: 'GET',
      url: entry.name,
      status: 0,
      ms: Math.round(entry.duration || 0),
      size: entry.transferSize || entry.encodedBodySize || 0,
      type: entry.initiatorType || 'other',
      done: true,
      headers: null,
    });
  }

  try {
    if (window.PerformanceObserver) {
      new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (entry) {
          try { addResource(entry); } catch (err) { /* ignore */ }
        });
      }).observe({ type: 'resource', buffered: true });
    }
  } catch (err) { /* older browser, or observation already taken */ }

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

  function bytes(n) {
    if (!n) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
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
      network: net.slice(-20).map(function (item) {
        return {
          method: item.method,
          url: item.url,
          status: item.status,
          type: item.type,
          size: item.size,
          ms: item.ms,
          failed: item.failed || null,
        };
      }),
      elements: {
        selected: elements.selected ? nodeSelector(elements.selected) : null,
        nodeCount: document.getElementsByTagName('*').length,
        stylesheets: document.styleSheets.length,
        scripts: document.scripts.length,
      },
      console: logs.slice(-80).map(function (entry) {
        return entry.at + ' ' + entry.level + ' ' + entry.text;
      }),
    };
  }

  // ===== elements ================================================================

  var elements = {
    selected: null,
    selRow: null,
    picking: false,
    hovered: null,
    dirty: false,
    refs: null,
  };

  function nodeSelector(node) {
    if (!node || node.nodeType !== 1) return node ? '#' + node.nodeName : null;
    var name = node.tagName.toLowerCase();
    if (node.id) return name + '#' + node.id;
    var cls = node.getAttribute('class');
    if (cls && cls.trim()) return name + '.' + cls.trim().split(/\s+/).join('.');
    return name;
  }

  function nodePath(node) {
    if (!node) return '';
    if (node.nodeType === 9) return 'html';
    if (node.nodeType !== 1) return (node.parentElement ? nodePath(node.parentElement) : '') + ' > ' + (node.nodeName || 'node');
    var out = [];
    var cur = node;
    while (cur && cur.nodeType === 1) {
      var part = cur.tagName.toLowerCase();
      var parent = cur.parentElement;
      if (parent) {
        var index = 1;
        var sib = cur;
        while ((sib = sib.previousElementSibling)) index += 1;
        part += ':nth-child(' + index + ')';
      }
      out.unshift(part);
      cur = parent;
    }
    return out.join(' > ');
  }

  function nodeLabelHtml(node) {
    if (node.nodeType === 3) {
      return '<span class="strnode">"' + esc(truncate(node.nodeValue || '', 140)) + '"</span>';
    }
    if (node.nodeType === 8) {
      return '<span class="cmt">&lt;!--' + esc(truncate(node.nodeValue || '', 120)) + '--&gt;</span>';
    }
    if (node.nodeType === 9) return '<span class="tag">#document</span>';
    if (node.nodeType === 11) return '<span class="tag">#fragment</span>';
    if (node.nodeType !== 1) return '<span class="cmt">' + esc(node.nodeName) + '</span>';

    var html = '<span class="punct">&lt;</span><span class="tag">' + esc(node.tagName.toLowerCase()) + '</span>';
    var attrs = node.attributes || [];
    for (var i = 0; i < attrs.length; i += 1) {
      html += ' <span class="attrname">' + esc(attrs[i].name) + '</span>' +
        '<span class="punct">="</span><span class="attrval">' + esc(truncate(attrs[i].value, 80)) + '</span><span class="punct">"</span>';
    }
    return html + '<span class="punct">&gt;</span>';
  }

  function childNodesOf(node) {
    if (node.nodeType === 9) return node.documentElement ? [node.documentElement] : [];
    var out = [];
    var kids = node.childNodes;
    for (var i = 0; i < kids.length; i += 1) {
      var kid = kids[i];
      if (kid === host) continue; // our own overlay is not part of the page
      // Whitespace-only text nodes are noise: DevTools hides them too.
      if (kid.nodeType === 3 && !(kid.nodeValue || '').trim()) continue;
      out.push(kid);
    }
    return out;
  }

  function makeRow(node, depth) {
    var row = document.createElement('div');
    row.className = 'nrow';
    row.style.setProperty('--d', String(depth));
    row.setAttribute('data-depth', String(depth));

    var disc = document.createElement('span');
    disc.className = 'disc';
    var label = document.createElement('span');
    label.className = 'nlabel';
    label.innerHTML = nodeLabelHtml(node);
    row.appendChild(disc);
    row.appendChild(label);

    var kids = null;
    var open = false;
    var expandable = childNodesOf(node).length > 0 && node.nodeType !== 3 && node.nodeType !== 8;

    if (expandable) {
      disc.textContent = '▸';
      disc.addEventListener('click', function (event) {
        event.stopPropagation();
        if (open) collapse();
        else expand();
      });
    } else {
      disc.classList.add('leaf');
    }

    function expand() {
      if (!expandable) return;
      if (!kids) {
        kids = document.createElement('div');
        kids.className = 'nkids';
        var list = childNodesOf(node);
        for (var i = 0; i < list.length; i += 1) {
          kids.appendChild(makeRow(list[i], depth + 1).row);
        }
        row.parentNode.insertBefore(kids, row.nextSibling);
      }
      kids.hidden = false;
      open = true;
      disc.textContent = '▾';
      row.classList.add('open');
    }

    function collapse() {
      if (kids) kids.hidden = true;
      open = false;
      disc.textContent = '▸';
      row.classList.remove('open');
    }

    row.__veilNode = node;
    row.addEventListener('click', function () {
      selectNode(node, row);
    });

    return { row: row, expand: expand, collapse: collapse, node: node };
  }

  function crumbLabel(node) {
    if (!node || node.nodeType !== 1) return node ? node.nodeName : '?';
    var html = '&lt;' + esc(node.tagName.toLowerCase());
    if (node.id) html += '#' + esc(node.id);
    var cls = node.getAttribute('class');
    if (cls && cls.trim()) html += '.' + esc(cls.trim().split(/\s+/).join('.'));
    var attrs = node.attributes || [];
    for (var i = 0; i < attrs.length && i < 3; i += 1) {
      if (attrs[i].name === 'class' || attrs[i].name === 'id' || attrs[i].name === 'style') continue;
      html += ' <span class="an">' + esc(attrs[i].name) + '</span>="' +
        esc(truncate(attrs[i].value, 24)) + '"';
    }
    return html + '&gt;';
  }

  function drawHighlight(node, cls) {
    if (!root) return;
    var box = root.querySelector('.hl');
    if (!box) return;
    var el = node && node.nodeType === 1 ? node : node && node.parentElement;
    if (!el || el === host) {
      box.hidden = true;
      return;
    }
    var rect;
    try {
      rect = el.getBoundingClientRect();
    } catch (err) {
      box.hidden = true;
      return;
    }
    if (!rect || (!rect.width && !rect.height)) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    box.className = 'hl ' + (cls || 'sel');
    box.style.left = rect.left + 'px';
    box.style.top = rect.top + 'px';
    box.style.width = rect.width + 'px';
    box.style.height = rect.height + 'px';
  }

  function selectNode(node, rowEl) {
    if (!root || !node) return;
    elements.selected = node;
    if (elements.selRow && elements.selRow !== rowEl) elements.selRow.classList.remove('sel');
    var el = root.querySelector('.pane[data-pane="elements"]');
    if (!el) return;
    if (rowEl) {
      rowEl.classList.add('sel');
      elements.selRow = rowEl;
    } else {
      var target = root.querySelector('.nrow.sel');
      if (target) target.classList.remove('sel');
      elements.selRow = null;
    }
    renderCrumbs();
    renderSidebar();
    drawHighlight(node, 'sel');
  }

  function renderCrumbs() {
    var bar = root && root.querySelector('.pane[data-pane="elements"] .crumbs');
    if (!bar) return;
    var chain = [];
    var cur = elements.selected;
    while (cur && cur.nodeType === 1) {
      chain.unshift(cur);
      cur = cur.parentElement;
    }
    if (!chain.length) {
      bar.innerHTML = '<span class="hint">No node selected</span>';
      return;
    }
    var html = '';
    for (var i = 0; i < chain.length; i += 1) {
      if (i > 0) html += '<span class="sep2">▸</span>';
      html += '<button type="button" class="crumb' + (i === chain.length - 1 ? ' cur' : '') +
        '" data-c="' + i + '">' + crumbLabel(chain[i]) + '</button>';
    }
    bar.innerHTML = html;
    var buttons = bar.querySelectorAll('.crumb');
    for (var j = 0; j < buttons.length; j += 1) {
      buttons[j].addEventListener('click', function (event) {
        var idx = Number(event.currentTarget.getAttribute('data-c'));
        selectNode(chain[idx]);
        var tree = root.querySelector('.pane[data-pane="elements"] .tree');
        if (tree) tree.scrollTop = 0;
      });
    }
  }

  // --- stylesheet helpers --------------------------------------------------------

  var disabledDecls = new WeakMap();

  function declEntries(style) {
    var out = [];
    if (!style) return out;
    for (var i = 0; i < style.length; i += 1) {
      var prop = style.item(i);
      out.push({
        prop: prop,
        value: style.getPropertyValue(prop),
        priority: style.getPropertyPriority(prop),
        off: false,
      });
    }
    var off = disabledDecls.get(style);
    if (off) {
      for (var j = 0; j < off.length; j += 1) {
        out.push({ prop: off[j].prop, value: off[j].value, priority: off[j].priority, off: true });
      }
    }
    return out;
  }

  // Unchecking a declaration really removes it from the stylesheet (or from the
  // inline style), and keeps the value so re-checking restores it exactly.
  function setDecl(style, prop, enabled) {
    if (!style) return;
    var list = disabledDecls.get(style) || [];
    if (enabled) {
      for (var i = 0; i < list.length; i += 1) {
        if (list[i].prop === prop) {
          style.setProperty(list[i].prop, list[i].value, list[i].priority);
          list.splice(i, 1);
          break;
        }
      }
    } else {
      var value = style.getPropertyValue(prop);
      var priority = style.getPropertyPriority(prop);
      style.removeProperty(prop);
      list.push({ prop: prop, value: value, priority: priority });
    }
    disabledDecls.set(style, list);
  }

  function specificity(selector) {
    var ids = (selector.match(/#[\w-]+/g) || []).length;
    var classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) || []).length;
    var tags = selector
      .replace(/#[\w-]+/g, '')
      .replace(/\.[\w-]+|\[[^\]]+\]|::?[\w-]+(\([^)]*\))?/g, '')
      .split(/[\s>+~]+/)
      .filter(function (part) { return /^[a-zA-Z][\w-]*$/.test(part); }).length;
    return ids * 10000 + classes * 100 + tags;
  }

  function selectorSpecificity(selectorText, el) {
    var parts = String(selectorText).split(',');
    var best = -1;
    for (var i = 0; i < parts.length; i += 1) {
      var part = parts[i].trim();
      if (!part) continue;
      try {
        if (!el.matches(part)) continue;
      } catch (err) {
        continue;
      }
      best = Math.max(best, specificity(part));
    }
    return best;
  }

  function walkRules(rules, ctx, out) {
    for (var i = 0; i < rules.length; i += 1) {
      var rule = rules[i];
      if (rule.type === 1 && rule.selectorText) {
        out.push({ rule: rule, ctx: ctx });
      } else if (rule.cssRules) {
        var label = rule.conditionText || rule.name || 'group';
        var next = ctx ? ctx + ' · ' + label : '@' + String(label).slice(0, 40);
        walkRules(rule.cssRules, next, out);
      }
    }
  }

  function matchedRules(el) {
    var out = [];
    var cross = 0;
    var sheets = document.styleSheets;
    for (var i = 0; i < sheets.length; i += 1) {
      var rules;
      try {
        rules = sheets[i].cssRules;
      } catch (err) {
        cross += 1;
        continue;
      }
      if (!rules) continue;
      var list = [];
      try {
        walkRules(rules, '', list);
      } catch (err) {
        continue;
      }
      for (var j = 0; j < list.length; j += 1) {
        var spec = selectorSpecificity(list[j].rule.selectorText, el);
        if (spec < 0) continue;
        out.push({ rule: list[j].rule, ctx: list[j].ctx, spec: spec, sheet: sheets[i] });
      }
    }
    out.sort(function (a, b) { return b.spec - a.spec; });
    return { rules: out.slice(0, 60), total: out.length, cross: cross };
  }

  function ruleSource(rule) {
    var sheet = rule.parentStyleSheet;
    if (!sheet) return '';
    var name = sheet.href || (sheet.ownerNode && sheet.ownerNode.getAttribute && sheet.ownerNode.getAttribute('data-veil')) || 'inline';
    try {
      name = new URL(name, location.href).pathname.split('/').pop() || name;
    } catch (err) { /* keep as is */ }
    return name;
  }

  function declHtml(style, prop, value, priority, off) {
    return (
      '<div class="decl' + (off ? ' off' : '') + '">' +
      '<input type="checkbox" ' + (off ? '' : 'checked') + ' data-prop="' + esc(prop) + '">' +
      '<span class="pname">' + esc(prop) + '</span>' +
      '<span class="punct">:</span>' +
      '<input class="pval" data-prop="' + esc(prop) + '" value="' + esc(value) + '">' +
      (priority ? '<span class="prio">!' + esc(priority) + '</span>' : '') +
      '</div>'
    );
  }

  function renderSidebar() {
    var side = root && root.querySelector('.pane[data-pane="elements"] .split-side');
    if (!side) return;
    var node = elements.selected;

    if (!node) {
      side.innerHTML = '<p class="empty">Select a node in the tree to see its attributes and styles.</p>';
      return;
    }

    var html = '<div class="node-path mono">' + esc(nodeSelector(node)) + '</div>';

    // --- Attributes ---
    html += '<section class="sec"><h4>Attributes' +
      '<span class="grow"></span><button type="button" class="btn ghost small addattr">+</button></h4><div class="sec-body">';

    if (node.nodeType === 1) {
      var attrs = node.attributes || [];
      if (!attrs.length) html += '<p class="empty tight">No attributes.</p>';
      for (var i = 0; i < attrs.length; i += 1) {
        html += '<div class="arow"><span class="aname">' + esc(attrs[i].name) + '</span>' +
          '<input class="aval mono" data-attr="' + esc(attrs[i].name) + '" value="' + esc(attrs[i].value) + '" spellcheck="false"></div>';
      }
    } else if (node.nodeType === 3 || node.nodeType === 8) {
      html += '<div class="arow"><span class="aname">#text</span><span class="aval2">' +
        esc(truncate(node.nodeValue || '', 400)) + '</span></div>';
    } else {
      html += '<div class="arow"><span class="aname">node</span><span class="aval2">' +
        esc(node.nodeName) + '</span></div>';
    }
    html += '</div></section>';

    // --- Styles ---
    if (node.nodeType === 1) {
      html += '<section class="sec"><h4>Styles' +
        '<span class="grow"></span><button type="button" class="btn ghost small addstyle">+</button></h4>' +
        '<div class="sec-body styles-b">';

      var inline = declEntries(node.style);
      html += '<div class="rule"><div class="rsel">element.style<span class="ctx">' +
        esc(nodeSelector(node)) + '</span></div><div class="decls">';
      if (!inline.length) html += '<p class="empty tight">Empty — add a property above.</p>';
      for (var a = 0; a < inline.length; a += 1) {
        html += declHtml(node.style, inline[a].prop, inline[a].value, inline[a].priority, inline[a].off)
          .replace('<input type="checkbox"', '<input type="checkbox" data-scope="inline"');
      }
      html += '</div></div>';

      var info = matchedRules(node);
      if (info.cross) {
        html += '<p class="note">' + info.cross + ' stylesheet' + (info.cross === 1 ? '' : 's') +
          ' blocked from reading (cross-origin, no CORS) — not listed.</p>';
      }
      if (!info.rules.length) {
        html += '<p class="empty tight">No author rules match this node. Anything you see comes from the UA sheet or inline styles.</p>';
      }

      for (var r = 0; r < info.rules.length; r += 1) {
        var item = info.rules[r];
        var decls = declEntries(item.rule.style);
        html += '<div class="rule" data-rule="' + r + '">' +
          '<div class="rsel">' + esc(item.rule.selectorText) +
          '<span class="ctx">' + esc(ruleSource(item.rule)) + (item.ctx ? ' · ' + esc(item.ctx) : '') + '</span></div>' +
          '<div class="decls">';
        for (var d = 0; d < decls.length; d += 1) {
          html += declHtml(item.rule.style, decls[d].prop, decls[d].value, decls[d].priority, decls[d].off)
            .replace('<input type="checkbox"', '<input type="checkbox" data-scope="rule" data-rule="' + r + '"');
        }
        html += '</div></div>';
      }
      html += '</div></section>';
      elements.ruleList = info.rules;
    } else {
      elements.ruleList = [];
    }

    side.innerHTML = html;

    var inputs = side.querySelectorAll('.aval');
    for (var k = 0; k < inputs.length; k += 1) {
      inputs[k].addEventListener('change', function (event) {
        var name = event.currentTarget.getAttribute('data-attr');
        var value = event.currentTarget.value;
        if (!node || node.nodeType !== 1) return;
        try {
          if (value === '') node.removeAttribute(name);
          else node.setAttribute(name, value);
        } catch (err) { /* ignore */ }
        var tree = root.querySelector('.pane[data-pane="elements"] .nrow.sel .nlabel');
        if (tree) tree.innerHTML = nodeLabelHtml(node);
        push('info', 'Set ' + name + '="' + value + '" on ' + nodeSelector(node));
      });
    }

    var checks = side.querySelectorAll('.decl input[type="checkbox"]');
    for (var c = 0; c < checks.length; c += 1) {
      checks[c].addEventListener('change', function (event) {
        var box = event.currentTarget;
        var prop = box.getAttribute('data-prop');
        var scope = box.getAttribute('data-scope');
        if (!prop || !node) return;
        if (scope === 'rule') {
          var rule = elements.ruleList[Number(box.getAttribute('data-rule'))];
          if (rule) setDecl(rule.rule.style, prop, box.checked);
        } else {
          setDecl(node.style, prop, box.checked);
        }
        renderSidebar();
      });
    }

    var values = side.querySelectorAll('.decl input.pval');
    for (var v = 0; v < values.length; v += 1) {
      values[v].addEventListener('change', function (event) {
        var prop = event.currentTarget.getAttribute('data-prop');
        var scope = event.currentTarget.closest('.rule').querySelector('[data-scope]');
        var target = scope ? scope.getAttribute('data-scope') : 'inline';
        var value = event.currentTarget.value;
        if (!prop || !node) return;
        try {
          if (target === 'rule') {
            var idx = Number(event.currentTarget.closest('.rule').getAttribute('data-rule'));
            var rule = elements.ruleList[idx];
            if (rule) rule.rule.style.setProperty(prop, value);
          } else {
            node.style.setProperty(prop, value);
          }
        } catch (err) { /* ignore */ }
        renderSidebar();
      });
    }

    var add = side.querySelector('.addattr');
    if (add) {
      add.addEventListener('click', function () {
        if (!node || node.nodeType !== 1) return;
        var name = window.prompt('Attribute name');
        if (!name) return;
        var value = window.prompt('Value for ' + name, '') || '';
        try { node.setAttribute(name, value); } catch (err) { return; }
        renderSidebar();
        var label = root.querySelector('.pane[data-pane="elements"] .nrow.sel .nlabel');
        if (label) label.innerHTML = nodeLabelHtml(node);
        renderCrumbs();
      });
    }

    var addStyle = side.querySelector('.addstyle');
    if (addStyle) {
      addStyle.addEventListener('click', function () {
        if (!node || node.nodeType !== 1) return;
        var name = window.prompt('CSS property, e.g. outline');
        if (!name) return;
        var value = window.prompt(name + ':', '');
        if (value === null) return;
        try { node.style.setProperty(name, value); } catch (err) { return; }
        renderSidebar();
        drawHighlight(node, 'sel');
      });
    }
  }

  function highlightFor(node) {
    drawHighlight(node, 'sel');
  }

  function pickElement(event) {
    var path = event.composedPath ? event.composedPath() : [];
    if (path.indexOf(host) !== -1) return null;
    for (var i = 0; i < path.length; i += 1) {
      var node = path[i];
      if (node && node.nodeType === 1) return node;
    }
    return event.target && event.target.nodeType === 1 ? event.target : null;
  }

  function startPicking() {
    if (elements.picking) { stopPicking(); return; }
    elements.picking = true;
    if (!root) return;
    var dt = root.querySelector('.dt');
    if (dt) dt.classList.add('picking');
    var button = root.querySelector('.pane[data-pane="elements"] .picker');
    if (button) button.classList.add('on');
    var banner = root.querySelector('.pane[data-pane="elements"] .pickhint');
    if (banner) banner.hidden = false;

    document.addEventListener('mousemove', onPickMove, true);
    document.addEventListener('click', onPickClick, true);
    document.addEventListener('keydown', onPickKey, true);
  }

  function stopPicking() {
    if (!elements.picking) return;
    elements.picking = false;
    if (root) {
      var dt = root.querySelector('.dt');
      if (dt) dt.classList.remove('picking');
      var button = root.querySelector('.pane[data-pane="elements"] .picker');
      if (button) button.classList.remove('on');
      var banner = root.querySelector('.pane[data-pane="elements"] .pickhint');
      if (banner) banner.hidden = true;
    }
    document.removeEventListener('mousemove', onPickMove, true);
    document.removeEventListener('click', onPickClick, true);
    document.removeEventListener('keydown', onPickKey, true);
    if (elements.selected) drawHighlight(elements.selected, 'sel');
    else drawHighlight(null);
  }

  function onPickMove(event) {
    var el = pickElement(event);
    if (!el) {
      drawHighlight(null);
      return;
    }
    elements.hovered = el;
    drawHighlight(el, 'hover');
  }

  function onPickClick(event) {
    var el = pickElement(event);
    if (!el) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    stopPicking();
    selectNode(el);
    push('info', 'Picked <' + el.tagName.toLowerCase() + '> from the page');
  }

  function onPickKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      stopPicking();
    }
  }

  function renderElementsTree() {
    var tree = root && root.querySelector('.pane[data-pane="elements"] .tree');
    if (!tree) return;
    tree.innerHTML = '';
    var docEl = document.documentElement;
    if (!docEl) {
      tree.innerHTML = '<p class="empty">No document element yet.</p>';
      return;
    }
    var made = makeRow(docEl, 0);
    tree.appendChild(made.row);
    made.expand();

    // Open <body> too: that is where the page's real content is, and it is what
    // DevTools shows selected on a fresh inspector.
    var bodyRow = null;
    var rows = tree.querySelectorAll('.nrow');
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].__veilNode === document.body) { bodyRow = rows[i]; break; }
    }
    if (bodyRow) {
      var disc = bodyRow.querySelector('.disc');
      if (disc) disc.click();
    }
    var target = elements.selected && document.contains(elements.selected) ? elements.selected : document.body;
    if (target) selectNode(target, bodyRow && target === document.body ? bodyRow : null);
    elements.dirty = false;
  }

  var elementsPane = {
    init: function (pane) {
      pane.innerHTML =
        '<div class="bar">' +
        '<button type="button" class="btn picker" title="Click an element on the page to inspect it">' +
        '<span class="picker-dot"></span>Pick element</button>' +
        '<button type="button" class="btn refresh-tree" title="Rebuild the tree from the live DOM">Refresh</button>' +
        '<span class="grow"></span>' +
        '<span class="hint">Click a node to inspect</span>' +
        '</div>' +
        '<div class="pickhint" hidden>Picking: click an element on the page (Esc cancels)</div>' +
        '<div class="split">' +
        '<div class="split-main">' +
        '<div class="tree"></div>' +
        '<div class="crumbs"></div>' +
        '</div>' +
        '<div class="split-side"></div>' +
        '</div>';

      pane.querySelector('.picker').addEventListener('click', startPicking);
      pane.querySelector('.refresh-tree').addEventListener('click', function () {
        renderElementsTree();
        renderSidebar();
      });

      window.addEventListener(
        'scroll',
        function () {
          if (root && activeTab === 'elements' && elements.selected) drawHighlight(elements.selected, 'sel');
        },
        true,
      );

      renderElementsTree();
    },
    show: function () {
      if (!elements.selected) renderElementsTree();
      else drawHighlight(elements.selected, 'sel');
    },
  };

  // ===== console pane ============================================================

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
    return root ? root.querySelector('.pane[data-pane="console"] .clog') : null;
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
      : '<p class="empty" style="padding:8px 8px">No console messages yet. Anything this page logs, throws or fails to fetch shows up here.</p>';
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
    var empty = el.querySelector('.empty');
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
    var badge = root.querySelector('.tab[data-tab="console"] .badge');
    if (!badge) return;
    var count = errorCount();
    badge.hidden = count === 0;
    badge.textContent = count ? String(count) : '';
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

  function historyHandler(event) {
    var input = event.currentTarget;
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
  }

  var consolePane = {
    init: function (pane) {
      pane.innerHTML =
        '<div class="bar">' +
        '<input class="inp filter" placeholder="Filter messages" spellcheck="false">' +
        '<button type="button" class="btn clearc">Clear</button>' +
        '<span class="grow"></span>' +
        '<span class="hint">↑↓ history · Ctrl+L clear</span>' +
        '</div>' +
        '<div class="clog"></div>' +
        '<form class="cform">' +
        '<span class="prompt">›</span>' +
        '<input class="cinput" placeholder="Evaluate JavaScript in this page" spellcheck="false" autocomplete="off">' +
        '</form>';

      var filterInput = pane.querySelector('.filter');
      filterInput.addEventListener('input', function () {
        filterText = filterInput.value.trim().toLowerCase();
        renderConsole();
      });

      pane.querySelector('.clearc').addEventListener('click', function () {
        logs.length = 0;
        renderConsole();
      });

      var form = pane.querySelector('.cform');
      var input = pane.querySelector('.cinput');
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var code = input.value;
        input.value = '';
        evaluate(code);
      });
      input.addEventListener('keydown', historyHandler);
    },
    show: function () {
      renderConsole();
      var input = root && root.querySelector('.pane[data-pane="console"] .cinput');
      if (input) input.focus();
    },
  };

  // ===== network pane ============================================================

  var netFilter = '';
  var netSelected = null;

  function netRowHtml(item) {
    var status = item.failed ? 'failed' : (item.status || (item.done ? '—' : '…'));
    var bad = item.failed || item.status >= 400;
    return (
      '<div class="netrow' + (netSelected === item.id ? ' sel' : '') + '" data-id="' + item.id + '">' +
      '<span class="st ' + (bad ? 'bad' : 'ok') + '">' + esc(status) + '</span>' +
      '<span class="m">' + esc(item.method) + '</span>' +
      '<span class="u" title="' + esc(item.url) + '">' + esc(item.url) + '</span>' +
      '<span class="t">' + esc(item.type) + '</span>' +
      '<span class="sz">' + esc(bytes(item.size)) + '</span>' +
      '<span class="ms">' + esc(item.done ? item.ms + ' ms' : '…') + '</span>' +
      '</div>'
    );
  }

  function netDetailHtml(item) {
    if (!item) return '<p class="empty">Select a request to see its details.</p>';
    var html = '<div class="detail-grid">' +
      row('URL', item.url) +
      row('Method', item.method) +
      row('Status', item.failed ? 'failed' : (item.status || 'unknown')) +
      row('Type', item.type) +
      row('Size', item.size ? bytes(item.size) : 'not reported') +
      row('Time', item.done ? item.ms + ' ms' : 'in flight') +
      (item.failed ? row('Error', item.failed) : '') +
      '</div>';
    if (item.headers && item.headers.length) {
      html += '<h5>Response headers</h5><div class="hlist">';
      for (var i = 0; i < item.headers.length; i += 1) {
        html += '<div class="hrow"><span class="hk">' + esc(item.headers[i][0]) + '</span>' +
          '<span class="hv">' + esc(truncate(item.headers[i][1], 300)) + '</span></div>';
      }
      html += '</div>';
    } else if (item.kind === 'resource') {
      html += '<p class="note">Browsers do not expose headers or status codes for resources loaded by the ' +
        'page itself — only timing and size. Wrapped fetch/XHR calls do report status and headers.</p>';
    }
    return html;
  }

  function renderNetwork() {
    var pane = root && root.querySelector('.pane[data-pane="network"]');
    if (!pane) return;
    var rows = pane.querySelector('.netrows');
    if (!rows) return;
    var list = net.filter(function (item) {
      if (!netFilter) return true;
      return (item.url + ' ' + item.method + ' ' + item.type).toLowerCase().indexOf(netFilter) !== -1;
    });
    rows.innerHTML = list.length
      ? list.map(netRowHtml).join('')
      : '<p class="empty">No requests recorded yet. Anything this page fetches, XHRs or loads shows up here.</p>';
    var count = pane.querySelector('.netcount');
    if (count) {
      var failed = net.filter(function (item) { return item.failed || item.status >= 400; }).length;
      count.textContent = net.length + ' requests' + (failed ? ' · ' + failed + ' failed' : '');
    }
    var detail = pane.querySelector('.netdetail');
    if (detail) detail.innerHTML = netDetailHtml(net.filter(function (i) { return i.id === netSelected; })[0] || null);

    var rowEls = rows.querySelectorAll('.netrow');
    for (var i = 0; i < rowEls.length; i += 1) {
      rowEls[i].addEventListener('click', function (event) {
        netSelected = Number(event.currentTarget.getAttribute('data-id'));
        renderNetwork();
      });
    }
  }

  var networkPane = {
    init: function (pane) {
      pane.innerHTML =
        '<div class="bar">' +
        '<input class="inp netfilter" placeholder="Filter requests" spellcheck="false">' +
        '<button type="button" class="btn clearnet">Clear</button>' +
        '<span class="grow"></span><span class="hint netcount"></span>' +
        '</div>' +
        '<div class="nethead"><span>Status</span><span>Method</span><span>URL</span>' +
        '<span>Type</span><span>Size</span><span>Time</span></div>' +
        '<div class="netrows"></div>' +
        '<div class="netdetail"></div>';

      var filterInput = pane.querySelector('.netfilter');
      filterInput.addEventListener('input', function () {
        netFilter = filterInput.value.trim().toLowerCase();
        renderNetwork();
      });
      pane.querySelector('.clearnet').addEventListener('click', function () {
        net.length = 0;
        netSelected = null;
        renderNetwork();
      });
      renderNetwork();
    },
    show: renderNetwork,
  };

  // ===== resources pane ==========================================================

  var resCategory = 'localStorage';

  function storageRows(store) {
    var out = [];
    try {
      for (var i = 0; i < store.length; i += 1) {
        var key = store.key(i);
        out.push({ key: key, value: store.getItem(key) });
      }
    } catch (err) { /* access denied */ }
    return out;
  }

  function cookieRows() {
    var out = [];
    var raw = '';
    try { raw = document.cookie || ''; } catch (err) { raw = ''; }
    if (!raw) return out;
    raw.split(';').forEach(function (part) {
      var idx = part.indexOf('=');
      if (idx === -1) return;
      out.push({ key: part.slice(0, idx).trim(), value: part.slice(idx + 1) });
    });
    return out;
  }

  function resourceRows() {
    if (resCategory === 'cookies') return cookieRows();
    try {
      return storageRows(resCategory === 'localStorage' ? window.localStorage : window.sessionStorage);
    } catch (err) {
      return [];
    }
  }

  function renderResources() {
    var pane = root && root.querySelector('.pane[data-pane="resources"]');
    if (!pane) return;
    var items = resourceRows();
    var body = pane.querySelector('.resbody');
    var cats = pane.querySelectorAll('.rescat');
    for (var i = 0; i < cats.length; i += 1) {
      cats[i].classList.toggle('on', cats[i].getAttribute('data-cat') === resCategory);
    }
    var label = resCategory === 'localStorage' ? 'localStorage'
      : resCategory === 'sessionStorage' ? 'sessionStorage' : 'Cookies (document.cookie)';
    body.innerHTML =
      '<div class="reshead"><span class="resname">' + esc(label) + '</span>' +
      '<span class="rescount">' + items.length + ' ' + (items.length === 1 ? 'entry' : 'entries') + '</span>' +
      '<span class="grow"></span>' +
      (resCategory === 'cookies' ? '' : '<button type="button" class="btn small resadd">+ Add</button>') +
      '<button type="button" class="btn small resreload">Refresh</button></div>' +
      '<div class="restable">' +
      (items.length
        ? items.map(function (item) {
            return '<div class="resrow"><span class="reskey" title="' + esc(item.key) + '">' + esc(item.key) + '</span>' +
              '<span class="resval" title="' + esc(item.value) + '">' + esc(truncate(item.value, 400)) + '</span>' +
              '<button type="button" class="btn ghost small resdel" data-key="' + esc(item.key) + '">Delete</button></div>';
          }).join('')
        : '<p class="empty">Nothing stored here. Cookies are listed as the page can see them — HttpOnly ones are invisible by design.</p>') +
      '</div>';

    var dels = body.querySelectorAll('.resdel');
    for (var d = 0; d < dels.length; d += 1) {
      dels[d].addEventListener('click', function (event) {
        var key = event.currentTarget.getAttribute('data-key');
        if (resCategory === 'cookies') {
          try { document.cookie = key + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'; } catch (err) { /* ignore */ }
        } else {
          try {
            (resCategory === 'localStorage' ? window.localStorage : window.sessionStorage).removeItem(key);
          } catch (err) { /* ignore */ }
        }
        renderResources();
      });
    }

    var add = body.querySelector('.resadd');
    if (add) {
      add.addEventListener('click', function () {
        var key = window.prompt('Key');
        if (!key) return;
        var value = window.prompt('Value for ' + key, '') || '';
        try {
          (resCategory === 'localStorage' ? window.localStorage : window.sessionStorage).setItem(key, value);
        } catch (err) { /* quota */ }
        renderResources();
      });
    }

    var reload = body.querySelector('.resreload');
    if (reload) reload.addEventListener('click', renderResources);
  }

  var resourcesPane = {
    init: function (pane) {
      pane.innerHTML =
        '<div class="res-layout">' +
        '<div class="res-list">' +
        '<button type="button" class="rescat on" data-cat="localStorage">localStorage</button>' +
        '<button type="button" class="rescat" data-cat="sessionStorage">sessionStorage</button>' +
        '<button type="button" class="rescat" data-cat="cookies">Cookies</button>' +
        '</div>' +
        '<div class="resbody"></div>' +
        '</div>';

      var cats = pane.querySelectorAll('.rescat');
      for (var i = 0; i < cats.length; i += 1) {
        cats[i].addEventListener('click', function (event) {
          resCategory = event.currentTarget.getAttribute('data-cat');
          renderResources();
        });
      }
      renderResources();
    },
    show: renderResources,
  };

  // ===== sources pane ============================================================

  var sourceItems = [];
  var sourceSelected = -1;
  var sourceText = '';
  var sourceFilter = '';

  function collectSources() {
    var out = [];
    var scripts = document.scripts;
    for (var i = 0; i < scripts.length; i += 1) {
      var script = scripts[i];
      var src = script.getAttribute('src');
      if (src) {
        out.push({
          kind: 'js',
          label: src,
          src: abs(src),
          load: (function (url) {
            return function () { return fetch(url, { cache: 'no-store' }).then(function (r) { return r.text(); }); };
          })(abs(src)),
        });
      } else if ((script.textContent || '').trim()) {
        out.push({
          kind: 'js',
          label: 'inline script #' + (i + 1),
          src: null,
          text: script.textContent,
          load: null,
        });
      }
    }
    var links = document.querySelectorAll('link[rel~="stylesheet"][href]');
    for (var j = 0; j < links.length; j += 1) {
      var href = links[j].getAttribute('href');
      out.push({
        kind: 'css',
        label: href,
        src: abs(href),
        load: (function (url) {
          return function () { return fetch(url, { cache: 'no-store' }).then(function (r) { return r.text(); }); };
        })(abs(href)),
      });
    }
    var styles = document.querySelectorAll('style');
    for (var k = 0; k < styles.length; k += 1) {
      if ((styles[k].textContent || '').trim()) {
        out.push({
          kind: 'css',
          label: 'inline style #' + (k + 1),
          src: null,
          text: styles[k].textContent,
          load: null,
        });
      }
    }
    return out;
  }

  function renderSourceList() {
    var pane = root && root.querySelector('.pane[data-pane="sources"]');
    if (!pane) return;
    var list = pane.querySelector('.src-list');
    var label = pane.querySelector('.srccount');
    if (!sourceItems.length) sourceItems = collectSources();
    if (label) label.textContent = sourceItems.length + ' files';
    list.innerHTML = sourceItems.length
      ? sourceItems.map(function (item, index) {
          return '<div class="src-item' + (index === sourceSelected ? ' on' : '') + '" data-i="' + index + '">' +
            '<span class="kind ' + item.kind + '">' + item.kind + '</span>' +
            esc(truncate(item.label, 90)) + '</div>';
        }).join('')
      : '<p class="empty">No scripts or stylesheets on this page.</p>';
    var items = list.querySelectorAll('.src-item');
    for (var i = 0; i < items.length; i += 1) {
      items[i].addEventListener('click', function (event) {
        openSource(Number(event.currentTarget.getAttribute('data-i')));
      });
    }
  }

  function openSource(index) {
    var item = sourceItems[index];
    if (!item) return;
    sourceSelected = index;
    renderSourceList();
    var view = root.querySelector('.pane[data-pane="sources"] .src-view');
    var meta = root.querySelector('.pane[data-pane="sources"] .srcmeta');
    if (meta) meta.textContent = item.label + (item.src ? ' · ' + item.src : ' · inline');
    if (view) view.innerHTML = '<p class="empty">Loading ' + esc(item.label) + ' …</p>';

    var done = function (text) {
      sourceText = text || '';
      if (!sourceText.trim()) {
        if (view) view.innerHTML = '<p class="empty">This file is empty, or the proxy returned nothing for it.</p>';
        return;
      }
      renderSourceText();
    };

    if (item.load) {
      item.load().then(done, function (err) {
        if (view) {
          view.innerHTML = '<p class="empty">Could not load this file: ' + esc(String(err && err.message || err)) +
            '. Cross-origin stylesheets and scripts are not readable from the page.</p>';
        }
      });
    } else {
      done(item.text || '');
    }
  }

  function renderSourceText() {
    var pane = root && root.querySelector('.pane[data-pane="sources"]');
    if (!pane) return;
    var view = pane.querySelector('.src-view');
    if (!view) return;
    var lines = sourceText.split('\n');
    var capped = lines.length > 5000;
    if (capped) lines = lines.slice(0, 5000);
    var needle = sourceFilter;
    var hits = 0;
    var html = '';
    for (var i = 0; i < lines.length; i += 1) {
      var line = esc(lines[i]);
      if (needle) {
        var lower = lines[i].toLowerCase();
        var at = lower.indexOf(needle);
        if (at !== -1) {
          hits += 1;
          var before = esc(lines[i].slice(0, at));
          var match = esc(lines[i].slice(at, at + needle.length));
          var after = esc(lines[i].slice(at + needle.length));
          line = before + '<mark>' + match + '</mark>' + after;
        }
      }
      html += '<div class="cline"><span class="lnum">' + (i + 1) + '</span>' +
        '<span class="ltext">' + (line || '&nbsp;') + '</span></div>';
    }
    view.innerHTML = html;
    var count = pane.querySelector('.srchits');
    if (count) count.textContent = needle ? hits + ' matches' : lines.length + ' lines' + (capped ? ' (showing first 5000)' : '');
  }

  var sourcesPane = {
    init: function (pane) {
      pane.innerHTML =
        '<div class="bar">' +
        '<button type="button" class="btn srcrefresh">Rescan page</button>' +
        '<input class="inp srcfind" placeholder="Find in file" spellcheck="false">' +
        '<span class="grow"></span><span class="hint srchits"></span>' +
        '</div>' +
        '<div class="src-layout">' +
        '<div class="src-list"></div>' +
        '<div class="src-main">' +
        '<div class="srcmeta mono"></div>' +
        '<div class="src-view"></div>' +
        '</div>' +
        '</div>';

      pane.querySelector('.srcrefresh').addEventListener('click', function () {
        sourceItems = collectSources();
        sourceSelected = -1;
        sourceText = '';
        renderSourceList();
        var view = pane.querySelector('.src-view');
        if (view) view.innerHTML = '<p class="empty">Pick a file on the left.</p>';
      });

      var find = pane.querySelector('.srcfind');
      find.addEventListener('input', function () {
        sourceFilter = find.value.trim().toLowerCase();
        renderSourceText();
      });

      renderSourceList();
      var view = pane.querySelector('.src-view');
      if (view) view.innerHTML = '<p class="empty">Pick a file on the left. Scripts and stylesheets are fetched through the proxy, so you see exactly what the page received.</p>';
    },
    show: renderSourceList,
  };

  // ===== snippets pane ===========================================================

  var SNIP_KEY = 'veil.snippets';
  var snippets = [];
  var snippetIndex = -1;

  function loadSnippets() {
    try {
      var raw = localStorage.getItem(SNIP_KEY);
      snippets = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(snippets)) snippets = [];
    } catch (err) {
      snippets = [];
    }
  }

  function saveSnippets() {
    try { localStorage.setItem(SNIP_KEY, JSON.stringify(snippets)); } catch (err) { /* ignore */ }
  }

  function renderSnippets() {
    var pane = root && root.querySelector('.pane[data-pane="snippets"]');
    if (!pane) return;
    var list = pane.querySelector('.snip-list');
    list.innerHTML = snippets.length
      ? snippets.map(function (item, index) {
          return '<div class="snip-item' + (index === snippetIndex ? ' on' : '') + '" data-i="' + index + '">' +
            esc(truncate(item.name, 40)) + '</div>';
        }).join('')
      : '<p class="empty">No snippets saved yet. Write one below and press Save.</p>';
    var items = list.querySelectorAll('.snip-item');
    for (var i = 0; i < items.length; i += 1) {
      items[i].addEventListener('click', function (event) {
        snippetIndex = Number(event.currentTarget.getAttribute('data-i'));
        renderSnippets();
      });
    }
    var nameInput = pane.querySelector('.snip-name');
    var codeInput = pane.querySelector('.snip-code');
    if (snippetIndex >= 0 && snippets[snippetIndex]) {
      if (document.activeElement !== nameInput) nameInput.value = snippets[snippetIndex].name;
      if (document.activeElement !== codeInput) codeInput.value = snippets[snippetIndex].code;
    }
    var result = pane.querySelector('.snip-result');
    if (!result.textContent) result.textContent = 'Runs in the page, not in the panel. Output goes to the Console tab.';
  }

  var snippetsPane = {
    init: function (pane) {
      loadSnippets();
      pane.innerHTML =
        '<div class="snip-layout">' +
        '<div class="snip-list"></div>' +
        '<div class="snip-main">' +
        '<div class="bar">' +
        '<input class="inp snip-name" placeholder="Snippet name" spellcheck="false">' +
        '<button type="button" class="btn snip-run">Run</button>' +
        '<button type="button" class="btn snip-save">Save</button>' +
        '<button type="button" class="btn ghost snip-new">New</button>' +
        '<button type="button" class="btn ghost snip-del">Delete</button>' +
        '</div>' +
        '<textarea class="snip-code" spellcheck="false" placeholder="// Runs in the page\'s global scope.&#10;document.querySelectorAll(\'a\').length"></textarea>' +
        '<div class="snip-result"></div>' +
        '</div></div>';

      pane.querySelector('.snip-run').addEventListener('click', function () {
        var code = pane.querySelector('.snip-code').value.trim();
        if (!code) return;
        var result = pane.querySelector('.snip-result');
        result.textContent = 'Ran at ' + stamp() + ' — see the Console tab for the result.';
        evaluate(code);
      });

      pane.querySelector('.snip-save').addEventListener('click', function () {
        var name = pane.querySelector('.snip-name').value.trim() || 'Snippet ' + (snippets.length + 1);
        var code = pane.querySelector('.snip-code').value;
        if (snippetIndex >= 0 && snippets[snippetIndex]) {
          snippets[snippetIndex] = { name: name, code: code };
        } else {
          snippets.push({ name: name, code: code });
          snippetIndex = snippets.length - 1;
        }
        saveSnippets();
        renderSnippets();
        pane.querySelector('.snip-result').textContent = 'Saved “' + name + '” in this browser.';
      });

      pane.querySelector('.snip-new').addEventListener('click', function () {
        snippetIndex = -1;
        pane.querySelector('.snip-name').value = '';
        pane.querySelector('.snip-code').value = '';
        pane.querySelector('.snip-result').textContent = 'New snippet — name it and press Save.';
        renderSnippets();
      });

      pane.querySelector('.snip-del').addEventListener('click', function () {
        if (snippetIndex < 0) return;
        snippets.splice(snippetIndex, 1);
        snippetIndex = -1;
        saveSnippets();
        pane.querySelector('.snip-name').value = '';
        pane.querySelector('.snip-code').value = '';
        renderSnippets();
      });

      renderSnippets();
    },
    show: renderSnippets,
  };

  // ===== info pane ===============================================================

  function renderInfo() {
    var pane = root && root.querySelector('.pane[data-pane="info"]');
    if (!pane) return;
    var body = pane.querySelector('.info-body');
    var nav = performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
    var target = currentTarget();
    var store = settings();
    var html = '';

    html += '<section class="sec"><h4>Page</h4><div class="sec-body">' +
      row('URL', location.href) +
      row('Proxied target', target || 'not proxied (a Veil page)') +
      row('Title', document.title) +
      row('Referrer', document.referrer) +
      row('Language', navigator.language) +
      row('Viewport', window.innerWidth + '×' + window.innerHeight + ' @' + (window.devicePixelRatio || 1) + 'x') +
      row('Doctype', document.doctype ? '<!DOCTYPE ' + document.doctype.name + '>' : 'none') +
      '</div></section>';

    html += '<section class="sec"><h4>Document</h4><div class="sec-body">' +
      row('Elements', document.getElementsByTagName('*').length) +
      row('Stylesheets', document.styleSheets.length) +
      row('Scripts', document.scripts.length) +
      row('Images', document.images.length) +
      row('Forms', document.forms.length) +
      row('Cookies visible', cookieRows().length) +
      '</div></section>';

    html += '<section class="sec"><h4>Timing</h4><div class="sec-body">' +
      (nav
        ? row('Response', Math.round(nav.responseEnd - nav.requestStart) + ' ms') +
          row('DOM ready', Math.round(nav.domContentLoadedEventEnd - nav.startTime) + ' ms') +
          row('Load', Math.round(nav.loadEventEnd ? nav.loadEventEnd - nav.startTime : 0) + ' ms') +
          row('Transfer', bytes(nav.transferSize))
        : row('Navigation timing', 'not available')) +
      row('Requests seen', net.length) +
      '</div></section>';

    html += '<section class="sec"><h4>Shim patches</h4><div class="sec-body"><div class="chips">' +
      patchStatus().map(function (pair) {
        return '<span class="chip ' + (pair[1] ? 'on' : 'off') + '">' + esc(pair[0]) + '</span>';
      }).join('') + '</div>' +
      (target ? '' : '<p class="note">This is a Veil page, so the shim never loads here.</p>') +
      '</div></section>';

    html += '<section class="sec"><h4>Stored settings</h4><div class="sec-body">' +
      (Object.keys(store).length
        ? Object.keys(store).map(function (key) { return row(key, truncate(store[key], 120)); }).join('')
        : '<p class="empty tight">Nothing in localStorage.</p>') +
      '</div></section>';

    html += '<section class="sec"><h4>Agent</h4><div class="sec-body">' +
      row('User agent', navigator.userAgent) +
      row('Platform', navigator.platform) +
      row('Online', navigator.onLine ? 'yes' : 'no') +
      '</div></section>';

    body.innerHTML = html;
  }

  var infoPane = {
    init: function (pane) {
      pane.innerHTML = '<div class="info-body"></div>';
      renderInfo();
    },
    show: renderInfo,
  };

  // ===== settings pane ===========================================================

  function renderSettings() {
    var pane = root && root.querySelector('.pane[data-pane="settings"]');
    if (!pane) return;
    var body = pane.querySelector('.set-body');
    body.innerHTML =
      '<section class="sec"><h4>Capture</h4><div class="sec-body">' +
      '<label class="tog"><input type="checkbox" data-pref="logs"' + (prefs.logs ? ' checked' : '') + '>' +
      '<span>Console messages and exceptions</span></label>' +
      '<label class="tog"><input type="checkbox" data-pref="net"' + (prefs.net ? ' checked' : '') + '>' +
      '<span>Network activity</span></label>' +
      '<label class="tog"><input type="checkbox" data-pref="autoOpen"' + (prefs.autoOpen ? ' checked' : '') + '>' +
      '<span>Open the panel when an uncaught error happens</span></label>' +
      '<p class="note">Turning capture off stops new entries; it does not delete what is already there. ' +
      'The console buffer is memory-only and never leaves this tab.</p>' +
      '</div></section>' +

      '<section class="sec"><h4>Buffers</h4><div class="sec-body">' +
      '<div class="btnrow">' +
      '<button type="button" class="btn set-clearconsole">Clear console</button>' +
      '<button type="button" class="btn set-clearnet">Clear network</button>' +
      '<button type="button" class="btn ghost set-clearserver">Clear server log</button>' +
      '</div></div></section>' +

      '<section class="sec"><h4>Page</h4><div class="sec-body"><div class="btnrow">' +
      '<button type="button" class="btn set-copy">Copy report</button>' +
      '<button type="button" class="btn ghost set-reload">Reload page</button>' +
      '<button type="button" class="btn ghost set-home">Veil home</button>' +
      '</div></div></section>' +

      '<section class="sec"><h4>Overlay</h4><div class="sec-body">' +
      row('Toggle', 'Ctrl+Alt+D · Cmd+Alt+D') +
      row('Deep link', '?debug=1') +
      row('Build', 'Veil DevTools · 9 tabs') +
      row('Target', currentTarget() || 'Veil page') +
      '</div></section>';

    var toggles = body.querySelectorAll('[data-pref]');
    for (var i = 0; i < toggles.length; i += 1) {
      toggles[i].addEventListener('change', function (event) {
        var key = event.currentTarget.getAttribute('data-pref');
        prefs[key] = event.currentTarget.checked;
        savePrefs();
      });
    }

    var wire = function (sel, fn) {
      var button = body.querySelector(sel);
      if (button) button.addEventListener('click', fn);
    };
    wire('.set-clearconsole', function () { logs.length = 0; renderConsole(); });
    wire('.set-clearnet', function () { net.length = 0; netSelected = null; renderNetwork(); });
    wire('.set-clearserver', clear);
    wire('.set-copy', copyReport);
    wire('.set-reload', function () { location.reload(); });
    wire('.set-home', function () { location.href = '/'; });
  }

  var settingsPane = {
    init: function (pane) {
      pane.innerHTML = '<div class="set-body"></div>';
      renderSettings();
    },
    show: renderSettings,
  };

  // ===== overview pane ===========================================================

  function renderOverview() {
    var pane = root && root.querySelector('.pane[data-pane="overview"]');
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
      : '<p class="note">Not a proxied page, so the shim is not injected here. Open a site through Veil to see patch status.</p>';

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
        : '<p class="note">No matching request in the server log. It may have scrolled out, or been served from another process.</p>') +
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
        : '<p class="note">Could not read <code>/__debug/state</code>. The server may be down.</p>') +
      '</section>' +

      '<section>' +
      '<h3>Shim patches</h3>' +
      '<div class="chips">' + patches + '</div>' +
      '</section>' +

      '<section>' +
      '<h3>Settings</h3>' +
      (storeRows || '<p class="note">Nothing stored yet.</p>') +
      '</section>' +

      '<section>' +
      '<h3>Recent proxy requests</h3>' +
      (rows || '<p class="note">No proxied requests recorded yet.</p>') +
      '</section>' +

      '<section>' +
      '<h3>Probe a URL</h3>' +
      '<div class="probe">' +
      '<input class="field" type="text" placeholder="https://example.com" spellcheck="false">' +
      '<button type="button" class="btn go">Test</button>' +
      '</div>' +
      '<p class="note" id="probe-result">' + esc(probeResult || 'Sends the URL through the proxy and reports status and timing.') + '</p>' +
      '</section>' +

      '<p class="note foot">Trace IDs match the error screen. Copy report puts all of this on the clipboard.</p>';

    var probeButton = pane.querySelector('.probe .go');
    var probeInput = pane.querySelector('.probe input');
    probeButton.addEventListener('click', function () {
      runProbe(probeInput.value.trim());
    });
    probeInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') runProbe(probeInput.value.trim());
    });
  }

  var overviewPane = {
    init: function (pane) {
      pane.classList.add('scroll');
      renderOverview();
    },
    show: function () {
      renderOverview();
      refresh();
    },
  };

  // ===== shell ===================================================================

  var panes = {
    console: consolePane,
    elements: elementsPane,
    network: networkPane,
    resources: resourcesPane,
    sources: sourcesPane,
    snippets: snippetsPane,
    info: infoPane,
    overview: overviewPane,
    settings: settingsPane,
  };

  var TABS = [
    ['console', 'Console'],
    ['elements', 'Elements'],
    ['network', 'Network'],
    ['resources', 'Resources'],
    ['sources', 'Sources'],
    ['snippets', 'Snippets'],
    ['info', 'Info'],
    ['overview', 'Veil'],
    ['settings', 'Settings'],
  ];

  function setTab(name) {
    if (!root) return;
    if (!panes[name]) name = 'console';
    if (elements.picking && name !== 'elements') stopPicking();
    activeTab = name;

    var tabs = root.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i += 1) {
      var on = tabs[i].getAttribute('data-tab') === name;
      tabs[i].classList.toggle('on', on);
      tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }

    var all = root.querySelectorAll('.pane');
    for (var j = 0; j < all.length; j += 1) {
      all[j].hidden = all[j].getAttribute('data-pane') !== name;
    }

    var pane = panes[name];
    var el = root.querySelector('.pane[data-pane="' + name + '"]');
    if (el && !pane.__ready) {
      pane.init(el);
      pane.__ready = true;
    }
    if (el && pane.show) pane.show();

    if (name === 'overview') refresh();
    if (name === 'elements' && elements.selected) drawHighlight(elements.selected, 'sel');
    else drawHighlight(null);
    updateStatus();
  }

  function updateStatus() {
    if (!root) return;
    var label = root.querySelector('.status .starget');
    if (!label) return;
    var target = currentTarget();
    label.textContent = target ? 'proxied · ' + target : 'Veil page · ' + location.host;
    var counts = root.querySelector('.status .scounts');
    if (counts) {
      counts.textContent = net.length + ' requests · ' + logs.length + ' messages' +
        (errorCount() ? ' · ' + errorCount() + ' errors' : '');
    }
  }

  function runProbe(value) {
    var pane = root && root.querySelector('.pane[data-pane="overview"]');
    var out = pane && pane.querySelector('#probe-result');
    if (!value) { if (out) out.textContent = 'Enter a full URL, including https://'; return; }
    var url;
    try {
      url = new URL(value);
    } catch (err) {
      if (out) out.textContent = 'That is not a valid URL.';
      return;
    }
    if (out) out.textContent = 'Testing ' + url.href + ' …';
    var started = performance.now();
    fetch(PREFIX + encode(url.href), { method: 'HEAD', cache: 'no-store' })
      .then(function (res) {
        var ms = Math.round(performance.now() - started);
        probeResult = res.status + ' in ' + ms + ' ms (' + res.headers.get('content-type') + ')';
        if (out) out.textContent = probeResult;
      })
      .catch(function (err) {
        probeResult = 'Probe failed: ' + err;
        if (out) out.textContent = probeResult;
      });
  }

  function refresh() {
    fetch('/__debug/state', { cache: 'no-store' })
      .then(function (res) { return res.json(); })
      .then(function (json) {
        lastState = json;
        if (activeTab === 'overview') renderOverview();
        updateStatus();
      })
      .catch(function () {
        lastState = { ok: false };
        if (activeTab === 'overview') renderOverview();
      });
  }

  function copyReport() {
    var text = JSON.stringify(buildReport(), null, 2);
    var done = function () {
      var buttons = root.querySelectorAll('.copy');
      for (var i = 0; i < buttons.length; i += 1) {
        buttons[i].textContent = 'Copied';
        (function (button) {
          setTimeout(function () { button.textContent = 'Copy report'; }, 1400);
        })(buttons[i]);
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

  var STYLE =
    ':host{all:initial}' +
    '*{box-sizing:border-box}' +
    '.dt{position:absolute;inset:0;overflow:hidden;display:flex;flex-direction:column;background:#1c1b22;color:#e6e6ec;' +
    'font:400 12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}' +
    '.dt.picking{opacity:.35}' +
    '.tabbar{display:flex;align-items:stretch;height:34px;background:#2b2a33;border-bottom:1px solid #0e0e12;flex:0 0 auto}' +
    '.tabs{display:flex;flex:1;min-width:0;overflow-x:auto;scrollbar-width:thin;scrollbar-color:#4a4a56 transparent}' +
    '.tabs::-webkit-scrollbar{height:5px}' +
    '.tabs::-webkit-scrollbar-thumb{background:#4a4a56;border-radius:3px}' +
    '.tab{all:unset;display:flex;align-items:center;gap:5px;padding:0 10px;font-size:11.5px;color:#cdcdd6;' +
    'cursor:pointer;border-right:1px solid #3a3a44;white-space:nowrap}' +
    '.tab:hover{background:#3a3943;color:#fff}' +
    '.tab.on{background:#1c1b22;color:#fff;box-shadow:inset 0 -2px 0 #0a84ff}' +
    '.tab:focus-visible{outline:1px solid #0a84ff;outline-offset:-2px}' +
    '.badge{padding:0 5px;border-radius:9px;background:#f87171;color:#1b1116;font-size:10px;font-weight:700}' +
    '.tools{display:flex;align-items:center;gap:2px;padding-right:6px}' +
    '.icon{all:unset;display:grid;place-items:center;width:26px;height:26px;border-radius:4px;color:#cdcdd6;cursor:pointer}' +
    '.icon:hover{background:#3a3943;color:#fff}' +
    '.panes{flex:1;min-height:0;display:flex}' +
    '.pane{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;background:#1c1b22}' +
    '.pane[hidden]{display:none}' +
    '.pane.scroll{overflow:auto;padding:2px 12px 20px}' +
    '.bar{display:flex;align-items:center;gap:6px;padding:5px 8px;background:#26252d;border-bottom:1px solid #0e0e12;flex:0 0 auto;min-height:31px}' +
    '.bar .grow{flex:1}' +
    '.bar .hint{color:#8d8d9b;font-size:11px}' +
    '.inp{all:unset;flex:0 1 230px;min-width:70px;padding:4px 7px;border-radius:3px;background:#17161c;' +
    'border:1px solid #4a4a56;color:#e6e6ec;font:400 11.5px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}' +
    '.inp:focus{border-color:#0a84ff}' +
    '.btn{all:unset;display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:3px;background:#3a3943;' +
    'color:#e6e6ec;font-size:11.5px;cursor:pointer;border:1px solid transparent;white-space:nowrap}' +
    '.btn:hover{background:#474652}' +
    '.btn.on{background:#0a84ff;color:#fff}' +
    '.btn.ghost{background:transparent;color:#b9b9c4;border-color:#4a4a56}' +
    '.btn.ghost:hover{background:#3a3943}' +
    '.btn.small{padding:1px 7px;font-size:11px}' +
    '.status{flex:0 0 auto;display:flex;align-items:center;gap:10px;height:26px;padding:0 8px;background:#2b2a33;' +
    'border-top:1px solid #0e0e12;font-size:11px;color:#9c9caa}' +
    '.status .starget{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%}' +
    '.status .spacer{flex:1}' +
    '.sbtn{all:unset;cursor:pointer;padding:2px 6px;border-radius:3px;color:#b9b9c4}' +
    '.sbtn:hover{background:#3a3943;color:#fff}' +
    '.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}' +
    '.hl{position:fixed;pointer-events:none;z-index:5;background:rgba(10,132,255,.22);outline:1px solid #0a84ff}' +
    '.hl.hover{background:rgba(10,132,255,.12);outline-color:#5aa9ff}' +
    '.hl[hidden]{display:none}' +
    '.punct{color:#8f8f9e}' +
    '.tag{color:#7fc4ff}' +
    '.attrname{color:#b9a7ff}' +
    '.attrval{color:#8fe3a8}' +
    '.strnode{color:#e6e6ec}' +
    '.cmt{color:#7d7d8a}' +
    '.split{flex:1;min-height:0;display:flex}' +
    '.split-main{flex:1;min-width:0;display:flex;flex-direction:column}' +
    '.split-side{width:min(46%,520px);min-width:220px;border-left:1px solid #0e0e12;background:#232229;overflow:auto;flex:0 0 auto}' +
    '.tree{flex:1;min-height:0;overflow:auto;padding:4px 0;font:400 11.5px/1.7 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}' +
    '.nrow{padding:0 6px 0 calc(var(--d,0) * 14px + 6px);display:flex;align-items:flex-start;gap:2px;white-space:pre-wrap;word-break:break-word;cursor:default}' +
    '.nrow:hover{background:#2a2932}' +
    '.nrow.sel{background:#2b4a72}' +
    '.disc{width:12px;flex:0 0 12px;color:#9c9caa;cursor:pointer;text-align:center;user-select:none}' +
    '.disc.leaf{visibility:hidden}' +
    '.nlabel{flex:1;min-width:0}' +
    '.nkids[hidden]{display:none}' +
    '.crumbs{flex:0 0 auto;display:flex;align-items:center;padding:3px 6px;background:#26252d;border-top:1px solid #0e0e12;' +
    'font:400 11px ui-monospace,Menlo,monospace;overflow-x:auto;white-space:nowrap}' +
    '.crumb{all:unset;cursor:pointer;padding:1px 4px;border-radius:3px;color:#cdcdd6}' +
    '.crumb:hover{background:#3a3943}' +
    '.crumb.cur{color:#fff;background:#3a3943}' +
    '.sep2{color:#6d6d7a;margin:0 1px}' +
    '.picker-dot{width:7px;height:7px;border-radius:9px;border:1px solid currentColor}' +
    '.pickhint{flex:0 0 auto;padding:4px 8px;background:#0a84ff;color:#fff;font-size:11.5px}' +
    '.pickhint[hidden]{display:none}' +
    '.node-path{padding:5px 8px;background:#2b2a33;border-bottom:1px solid #33323c;word-break:break-all}' +
    '.sec{border-bottom:1px solid #33323c}' +
    '.sec h4{margin:0;padding:4px 8px;font-size:11px;font-weight:600;color:#cfcfd8;background:#2b2a33;display:flex;align-items:center;gap:6px}' +
    '.sec h4 .grow{flex:1}' +
    '.sec-body{padding:5px 8px 8px}' +
    '.arow{display:grid;grid-template-columns:104px 1fr;gap:6px;align-items:baseline;padding:1px 0}' +
    '.aname{font:400 11px ui-monospace,Menlo,monospace;color:#b9a7ff;overflow:hidden;text-overflow:ellipsis}' +
    '.aval{all:unset;font:400 11px ui-monospace,Menlo,monospace;color:#8fe3a8;padding:1px 3px;border-radius:2px;word-break:break-all;cursor:text}' +
    '.aval:hover{background:#2f2e37}' +
    '.aval:focus{background:#10263c;outline:1px solid #0a84ff;color:#fff}' +
    '.aval2{font:400 11px ui-monospace,Menlo,monospace;color:#cdcdd6;word-break:break-all}' +
    '.rule{margin:0 0 6px}' +
    '.rsel{padding:2px 5px;background:#2b2a33;font:400 11px ui-monospace,Menlo,monospace;color:#7fc4ff;' +
    'border-radius:2px 2px 0 0;display:flex;gap:6px;align-items:baseline;flex-wrap:wrap;word-break:break-all}' +
    '.rsel .ctx{color:#8d8d9b;font-size:10px}' +
    '.decls{padding:2px 5px 3px 6px;background:#1f1e25;border-left:1px solid #3a3943}' +
    '.decl{display:flex;gap:5px;align-items:baseline;font:400 11px ui-monospace,Menlo,monospace;color:#dcdce4;padding:1px 0}' +
    '.decl input[type=checkbox]{margin:0;accent-color:#0a84ff;flex:0 0 auto}' +
    '.decl .pval{all:unset;flex:1;min-width:36px;font:400 11px ui-monospace,Menlo,monospace;color:#d7ba7d;padding:0 2px;border-radius:2px;word-break:break-all}' +
    '.decl .pval:hover{background:#2f2e37}' +
    '.decl .pval:focus{background:#10263c;outline:1px solid #0a84ff;color:#fff}' +
    '.pname{color:#9cdcfe;white-space:nowrap}' +
    '.prio{color:#ff9d9d;font-size:10px}' +
    '.decl.off .pname,.decl.off .pval{text-decoration:line-through;color:#8d8d9b}' +
    '.empty{padding:8px;color:#8d8d9b;font-size:11.5px;margin:0;line-height:1.55}' +
    '.empty.tight{padding:2px 0}' +
    '.note{color:#8d8d9b;font-size:11px;margin:5px 0 0;line-height:1.5}' +
    '.note code{font-family:ui-monospace,Menlo,monospace;background:#2f2e37;padding:1px 4px;border-radius:3px}' +
    '.row{display:grid;grid-template-columns:120px 1fr;gap:8px;padding:3px 0;border-bottom:1px solid #26252d}' +
    '.k{color:#8d8d9b;font-size:11px}' +
    '.v{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;word-break:break-all;color:#e6e6ec}' +
    '.v i{color:#5d5d68;font-style:normal}' +
    '.chips{display:flex;flex-wrap:wrap;gap:5px}' +
    '.chip{font-size:11px;padding:2px 8px;border-radius:99px;border:1px solid #4a4a56;color:#b9b9c4}' +
    '.chip.on{color:#a9f0bd;border-color:rgba(52,211,153,.5);background:rgba(52,211,153,.12)}' +
    '.chip.off{color:#fca5a5;border-color:rgba(248,113,113,.45);background:rgba(248,113,113,.1)}' +
    '.logrow{display:grid;grid-template-columns:38px 52px 42px 1fr;gap:6px;padding:3px 0;' +
    'font-family:ui-monospace,Menlo,monospace;font-size:11px;border-bottom:1px solid #26252d}' +
    '.logrow.ok .s{color:#9ce89c}.logrow.bad .s{color:#fca5a5}' +
    '.logrow .ms,.logrow .m{color:#8d8d9b}' +
    '.logrow .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#d9d9e4}' +
    '.probe{display:flex;gap:6px}' +
    '.field{flex:1;min-width:0;padding:5px 8px;border-radius:3px;background:#17161c;border:1px solid #4a4a56;' +
    'color:#e6e6ec;font:400 11.5px ui-monospace,Menlo,monospace;outline:none}' +
    '.field:focus-visible{border-color:#0a84ff}' +
    '.foot{margin-top:14px}' +
    '.clog{flex:1;min-height:0;overflow:auto;padding:2px 0;font:400 11.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}' +
    '.line{display:grid;grid-template-columns:58px 1fr;gap:8px;padding:2px 8px;border-bottom:1px solid rgba(255,255,255,.04)}' +
    '.line .lt{color:#5d5d68;font-size:10.5px;padding-top:2px}' +
    '.line .lm{white-space:pre-wrap;word-break:break-word;color:#e2e2ea}' +
    '.line.warn .lm{color:#fcd34d}' +
    '.line.error .lm{color:#fca5a5}' +
    '.line.net .lm{color:#93c5fd}' +
    '.line.net{background:rgba(59,130,246,.06)}' +
    '.line.info .lm{color:#a5b4fc}' +
    '.line.input{background:rgba(10,132,255,.1)}' +
    '.line.input .lm{color:#fff}' +
    '.line.input .lt{color:#5aa9ff}' +
    '.line.result .lm{color:#9ce89c}' +
    '.line.result .lt{color:#63c76a}' +
    '.cform{display:flex;align-items:center;gap:8px;padding:6px 10px;border-top:1px solid #0e0e12;background:#232229;flex:0 0 auto}' +
    '.prompt{color:#5aa9ff;font-family:ui-monospace,Menlo,monospace;font-size:13px;font-weight:700}' +
    '.cinput{flex:1;min-width:0;background:transparent;border:none;outline:none;color:#e6e6ec;' +
    'font:400 12px ui-monospace,Menlo,monospace;padding:4px 0}' +
    '.cinput::placeholder{color:#5d5d68}' +
    '.nethead,.netrow{display:grid;grid-template-columns:62px 58px 1fr 74px 62px 62px;gap:6px;align-items:baseline}' +
    '.nethead{flex:0 0 auto;padding:3px 8px;background:#26252d;border-bottom:1px solid #0e0e12;' +
    'font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:#8d8d9b}' +
    '.netrows{flex:1;min-height:0;overflow:auto;font:400 11px ui-monospace,SFMono-Regular,Menlo,monospace}' +
    '.netrow{padding:3px 8px;border-bottom:1px solid #26252d;cursor:default}' +
    '.netrow:hover{background:#2a2932}' +
    '.netrow.sel{background:#2b4a72}' +
    '.netrow .st.ok{color:#9ce89c}.netrow .st.bad{color:#fca5a5}' +
    '.netrow .m,.netrow .t,.netrow .sz,.netrow .ms{color:#9c9caa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.netrow .u{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e0e0e8}' +
    '.netdetail{flex:0 0 auto;max-height:34%;overflow:auto;border-top:1px solid #0e0e12;background:#232229;padding:6px 8px;' +
    'font:400 11px ui-monospace,Menlo,monospace}' +
    '.netdetail h5{margin:8px 0 3px;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:#8d8d9b}' +
    '.hrow{display:grid;grid-template-columns:160px 1fr;gap:8px;padding:1px 0}' +
    '.hrow .hk{color:#b9a7ff}.hrow .hv{color:#cdcdd6;word-break:break-all}' +
    '.res-layout{flex:1;min-height:0;display:flex}' +
    '.res-list{width:168px;flex:0 0 auto;background:#232229;border-right:1px solid #0e0e12;overflow:auto;padding:4px 0}' +
    '.rescat{all:unset;display:block;padding:4px 10px;font-size:11.5px;color:#cdcdd6;cursor:pointer;white-space:nowrap}' +
    '.rescat:hover{background:#2f2e37}' +
    '.rescat.on{background:#2b4a72;color:#fff}' +
    '.resbody{flex:1;min-width:0;display:flex;flex-direction:column;overflow:auto}' +
    '.reshead{display:flex;align-items:center;gap:8px;padding:5px 8px;background:#26252d;border-bottom:1px solid #0e0e12;flex:0 0 auto}' +
    '.resname{font-weight:600;font-size:11.5px}' +
    '.rescount{color:#8d8d9b;font-size:11px}' +
    '.reshead .grow{flex:1}' +
    '.restable{font:400 11px ui-monospace,SFMono-Regular,Menlo,monospace}' +
    '.resrow{display:grid;grid-template-columns:minmax(90px,26%) 1fr 62px;gap:8px;align-items:baseline;padding:3px 8px;border-bottom:1px solid #26252d}' +
    '.resrow:hover{background:#25242c}' +
    '.reskey{color:#9cdcfe;word-break:break-all}' +
    '.resval{color:#d7ba7d;word-break:break-all}' +
    '.src-layout{flex:1;min-height:0;display:flex}' +
    '.src-list{width:34%;min-width:170px;max-width:420px;flex:0 0 auto;overflow:auto;background:#232229;border-right:1px solid #0e0e12;padding:2px 0}' +
    '.src-item{padding:3px 8px;font:400 11px ui-monospace,Menlo,monospace;color:#cdcdd6;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.src-item:hover{background:#2f2e37}' +
    '.src-item.on{background:#2b4a72;color:#fff}' +
    '.src-item .kind{display:inline-block;min-width:26px;color:#8d8d9b;font-size:9.5px;text-transform:uppercase;margin-right:5px}' +
    '.src-item .kind.css{color:#d7ba7d}' +
    '.src-main{flex:1;min-width:0;display:flex;flex-direction:column}' +
    '.srcmeta{padding:4px 8px;background:#26252d;border-bottom:1px solid #0e0e12;color:#9c9caa;font-size:10.5px;' +
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 0 auto}' +
    '.src-view{flex:1;min-height:0;overflow:auto;font:400 11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;padding:4px 0}' +
    '.cline{display:flex;gap:8px;padding:0 8px}' +
    '.cline:hover{background:#25242c}' +
    '.lnum{width:42px;flex:0 0 42px;text-align:right;color:#5d5d68;user-select:none}' +
    '.ltext{white-space:pre-wrap;word-break:break-word;flex:1;min-width:0}' +
    'mark{background:#8a6d1a;color:#fff}' +
    '.snip-layout{flex:1;min-height:0;display:flex}' +
    '.snip-list{width:180px;flex:0 0 auto;overflow:auto;background:#232229;border-right:1px solid #0e0e12;padding:2px 0}' +
    '.snip-item{padding:3px 8px;font:400 11px ui-monospace,Menlo,monospace;color:#cdcdd6;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.snip-item:hover{background:#2f2e37}' +
    '.snip-item.on{background:#2b4a72;color:#fff}' +
    '.snip-main{flex:1;min-width:0;display:flex;flex-direction:column}' +
    '.snip-code{flex:1;min-height:120px;resize:none;background:#141319;color:#e6e6ec;border:none;border-top:1px solid #0e0e12;' +
    'padding:8px 10px;font:400 12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;outline:none;width:100%}' +
    '.snip-result{flex:0 0 auto;padding:5px 8px;background:#232229;border-top:1px solid #0e0e12;color:#9c9caa;font-size:11px}' +
    '.info-body,.set-body{flex:1;overflow:auto;padding:0 12px 20px}' +
    '.tog{display:flex;align-items:center;gap:8px;padding:3px 0;font-size:11.5px;color:#dcdce4}' +
    '.tog input{accent-color:#0a84ff;margin:0}' +
    '.btnrow{display:flex;flex-wrap:wrap;gap:6px}' +
    '.detail-grid{display:grid;grid-template-columns:1fr}' +
    '.detail-grid .row{grid-template-columns:90px 1fr}';

  function shellHtml() {
    var tabs = TABS.map(function (pair) {
      return '<button type="button" class="tab" data-tab="' + pair[0] + '" role="tab" aria-selected="false">' +
        esc(pair[1]) + (pair[0] === 'console' ? '<span class="badge" hidden>0</span>' : '') + '</button>';
    }).join('');

    var panesHtml = TABS.map(function (pair) {
      return '<div class="pane" data-pane="' + pair[0] + '" hidden></div>';
    }).join('');

    return (
      '<div class="dt">' +
      '<div class="tabbar"><div class="tabs" role="tablist">' + tabs + '</div>' +
      '<div class="tools">' +
      '<button type="button" class="icon copy" title="Copy report">⧉</button>' +
      '<button type="button" class="icon close" title="Close (Esc)">✕</button>' +
      '</div></div>' +
      '<div class="panes">' + panesHtml + '</div>' +
      '<div class="status"><span class="starget"></span><span class="spacer"></span>' +
      '<span class="scounts"></span>' +
      '<button type="button" class="sbtn sreload">Reload page</button>' +
      '<button type="button" class="sbtn shome">Veil home</button>' +
      '</div>' +
      '<div class="hl" hidden></div>' +
      '</div>'
    );
  }

  function open() {
    if (host) { refresh(); return; }
    host = document.createElement('div');
    host.id = '__veil_debug';
    // 100vw/100vh rather than inset:0: the initial containing block stops at the
    // page scrollbar, which would leave a 15px strip of the site visible.
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>' + STYLE + '</style>' + shellHtml();

    root.querySelector('.close').addEventListener('click', close);
    root.querySelector('.copy').addEventListener('click', copyReport);
    root.querySelector('.sreload').addEventListener('click', function () { location.reload(); });
    root.querySelector('.shome').addEventListener('click', function () { location.href = '/'; });

    var tabs = root.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i += 1) {
      tabs[i].addEventListener('click', function (event) {
        setTab(event.currentTarget.getAttribute('data-tab'));
      });
    }

    document.documentElement.appendChild(host);
    setTab(activeTab);
    refresh();
    timer = setInterval(function () {
      if (activeTab === 'overview' || activeTab === 'info') refresh();
      updateStatus();
    }, 4000);
  }

  function close() {
    stopPicking();
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

  onEntry = function (entry) {
    if (!host) return;
    appendConsoleEntry(entry);
    updateStatus();
  };
  onUpdate = function (entry) {
    if (!host) return;
    replaceConsoleEntry(entry);
  };

  window.__veilDebug = {
    open: open,
    close: close,
    toggle: toggle,
    refresh: refresh,
    report: buildReport,
    tab: setTab,
    console: {
      entries: function () { return logs.slice(); },
      run: evaluate,
      clear: function () { logs.length = 0; renderConsole(); },
    },
    network: {
      entries: function () { return net.slice(); },
      clear: function () { net.length = 0; netSelected = null; renderNetwork(); },
    },
    elements: {
      select: function (selector) {
        var el = null;
        try { el = document.querySelector(selector); } catch (err) { return null; }
        if (!el) return null;
        selectNode(el);
        setTab('elements');
        return el;
      },
      selected: function () { return elements.selected; },
      rules: function () { return (elements.ruleList || []).slice(); },
    },
    snippets: {
      list: function () { loadSnippets(); return snippets.slice(); },
    },
  };

  document.addEventListener(
    'keydown',
    function (event) {
      if (host && event.key === 'Escape' && !elements.picking) {
        close();
        return;
      }
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
