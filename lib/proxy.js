import { rewriteCss, rewriteHtml, rewriteJs, PROXY_PREFIX } from './rewrite.js';

export { PROXY_PREFIX };

const MAX_BODY = 16 * 1024 * 1024;
const TIMEOUT_MS = 25_000;

const REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'content-type',
  'cookie',
  'authorization',
  'range',
  'if-none-match',
  'if-modified-since',
];

const STRIP_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'trailer',
  'upgrade',
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'frame-options',
  'strict-transport-security',
  'permissions-policy',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'report-to',
  'reporting-endpoints',
  'alt-svc',
  'location',
  'set-cookie',
]);

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function isBlockedHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || host === '0.0.0.0' || host === '::') return true;
  if (/^127\./.test(host) || /^0\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true; // link-local + cloud metadata
  if (/^(fc|fd)[0-9a-f]{2}:/.test(host)) return true;
  if (/^fe80:/.test(host)) return true;
  return false;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function errorPage(status, title, detail) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #f3ecff; background: #0a0712;
    background-image: radial-gradient(60% 60% at 15% 0%, rgba(168,85,247,.28), transparent 70%),
                      radial-gradient(50% 50% at 90% 10%, rgba(34,211,238,.18), transparent 70%); }
  .card { width: min(560px, 100%); padding: 34px; border-radius: 22px;
    background: rgba(255,255,255,.055); border: 1px solid rgba(255,255,255,.11);
    box-shadow: 0 30px 80px rgba(0,0,0,.45); backdrop-filter: blur(18px); }
  .badge { display: inline-block; font-size: 12px; letter-spacing: .14em; text-transform: uppercase;
    color: #c4a7ff; background: rgba(168,85,247,.16); border: 1px solid rgba(168,85,247,.3);
    padding: 6px 12px; border-radius: 999px; margin-bottom: 18px; }
  h1 { margin: 0 0 10px; font-size: 22px; letter-spacing: -.02em; }
  p { margin: 0 0 22px; color: #b6a9cf; line-height: 1.6; font-size: 14.5px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;
    background: rgba(255,255,255,.07); padding: 3px 7px; border-radius: 7px; color: #e6dcff; word-break: break-all; }
  a { display: inline-block; text-decoration: none; font-weight: 600; font-size: 14px; color: #0a0712;
    background: linear-gradient(135deg, #c084fc, #22d3ee); padding: 11px 20px; border-radius: 12px; }
</style></head><body><div class="card">
<span class="badge">${status}</span><h1>${escapeHtml(title)}</h1><p>${detail}</p>
<a href="/">← Back to Veil</a></div></body></html>`;
}

function fail(res, status, title, detail) {
  const body = errorPage(status, title, detail);
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function rewriteCookies(headers) {
  const cookies = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [];
  return cookies
    .map((cookie) =>
      cookie
        .replace(/;\s*domain=[^;]*/gi, '')
        .replace(/;\s*secure/gi, '')
        .replace(/;\s*samesite=[^;]*/gi, '')
        .replace(/;\s*partitioned/gi, ''),
    )
    .map((cookie) => (/;\s*path=/i.test(cookie) ? cookie : `${cookie}; Path=/`))
    .filter(Boolean);
}

function describeError(err) {
  const cause = err && err.cause;
  const code = (cause && (cause.code || cause.message)) || (err && err.message) || 'unknown error';
  if (/ENOTFOUND|EAI_AGAIN/.test(String(code))) {
    return 'That domain could not be resolved. Check the spelling and try again.';
  }
  if (/CERT|SSL|TLS/i.test(String(code))) {
    return 'The site presented a certificate this proxy could not verify.';
  }
  if (/timeout|aborted/i.test(String(code))) {
    return 'The site took too long to respond.';
  }
  if (/ECONNREFUSED/.test(String(code))) {
    return 'The site refused the connection.';
  }
  return `The request failed (${escapeHtml(code)}).`;
}

export async function handleProxy(req, res) {
  const raw = String(req.url || '').slice(PROXY_PREFIX.length);
  if (!raw) return fail(res, 400, 'No address', 'The proxy needs a URL, like <code>/__p/https://example.com</code>.');

  let target;
  try {
    target = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return fail(res, 400, 'Invalid address', 'That URL could not be parsed.');
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return fail(res, 400, 'Unsupported scheme', 'Only <code>http</code> and <code>https</code> can be proxied.');
  }
  if (isBlockedHost(target.hostname)) {
    return fail(res, 403, 'Blocked address', 'Private, loopback and link-local addresses are not proxyable.');
  }

  const headers = { 'accept-encoding': 'gzip, deflate, br', 'user-agent': DEFAULT_UA };
  for (const name of REQUEST_HEADERS) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }
  if (!headers.accept) headers.accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

  // Subresource requests look same-origin to us, so the browser sends no
  // Origin/Referer. Re-attach the target's own origin: media and API endpoints
  // (googlevideo, youtubei) reject requests that arrive without them.
  if (!/text\/html/i.test(req.headers.accept || '')) {
    headers.origin = target.origin;
    headers.referer = target.href;
  }

  let body;
  if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
    try {
      body = await readBody(req);
    } catch (err) {
      return fail(res, 413, 'Request too large', escapeHtml(err.message));
    }
  }

  let upstream;
  try {
    upstream = await fetch(target.href, {
      method: req.method || 'GET',
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return fail(res, 502, 'Could not reach the site', describeError(err));
  }

  // Redirects are re-emitted through the proxy so navigation stays inside it.
  if (upstream.status >= 300 && upstream.status < 400) {
    const location = upstream.headers.get('location');
    const out = { 'cache-control': 'no-store' };
    if (location) {
      try {
        out.location = PROXY_PREFIX + new URL(location, target).href;
      } catch {
        out.location = location;
      }
    }
    res.writeHead(upstream.status, out);
    return res.end();
  }

  const responseHeaders = {};
  for (const [name, value] of upstream.headers) {
    if (STRIP_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    responseHeaders[name] = value;
  }

  const cookies = rewriteCookies(upstream.headers);
  if (cookies.length) responseHeaders['set-cookie'] = cookies;

  let buffer;
  try {
    buffer = Buffer.from(await upstream.arrayBuffer());
  } catch (err) {
    return fail(res, 502, 'Response failed', describeError(err));
  }

  const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
  const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml');
  const isCss = contentType.includes('text/css');
  const isJs = /javascript|ecmascript/.test(contentType);
  const isJson = /json/.test(contentType);

  // Bundles and API payloads carry the absolute URLs a SPA navigates and streams
  // from, so they need the same treatment as HTML attributes.
  if (isJs || isJson) {
    const out = Buffer.from(rewriteJs(buffer.toString('utf8')), 'utf8');
    res.writeHead(upstream.status, {
      ...responseHeaders,
      'content-length': out.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    return res.end(out);
  }

  if (isHtml || isCss) {
    const text = buffer.toString('utf8');
    const rewritten = isHtml
      ? rewriteHtml(text, target.href)
      : rewriteCss(text, target.href);
    const out = Buffer.from(rewritten, 'utf8');
    res.writeHead(upstream.status, {
      ...responseHeaders,
      'content-type': isHtml ? 'text/html; charset=utf-8' : 'text/css; charset=utf-8',
      'content-length': out.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    return res.end(out);
  }

  res.writeHead(upstream.status, {
    ...responseHeaders,
    'content-length': buffer.length,
  });
  res.end(buffer);
}
