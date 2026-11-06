import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeTarget, handleProxy, PROXY_PREFIX } from './lib/proxy.js';
import { encodeTarget } from './lib/rewrite.js';
import { clearLog, recent, stats } from './lib/diag.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

// Single-page apps rewrite their own address bar. A site that replaces the URL
// with a plain path (YouTube's "/results?search_query=…") lands here with its
// later requests, and every one of them used to 404. The referer still points at
// the proxied page they came from, so the request can be sent back inside the
// proxy instead of failing.
function recoverSpaRequest(req, url) {
  const referer = req.headers.referer || req.headers.origin;
  if (!referer) return null;
  let ref;
  try {
    ref = new URL(referer);
  } catch {
    return null;
  }
  if (ref.host !== req.headers.host) return null;
  if (!ref.pathname.startsWith(PROXY_PREFIX)) return null;

  const decoded = decodeTarget(ref.pathname.slice(PROXY_PREFIX.length));
  if (!decoded) return null;

  let origin;
  try {
    origin = new URL(decoded).origin;
  } catch {
    return null;
  }

  return PROXY_PREFIX + encodeTarget(origin + url.pathname + url.search);
}

const server = createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');

    if (url.pathname.startsWith(PROXY_PREFIX)) {
      return await handleProxy(req, res);
    }

    // Everything the debug overlay needs, in one call. Same-origin only: it is
    // served from this host and exposes nothing beyond local request metadata.
    if (url.pathname === '/__debug/state') {
      if (url.searchParams.get('clear') === '1') clearLog();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(
        JSON.stringify({
          ok: true,
          node: process.version,
          platform: `${process.platform}/${process.arch}`,
          pid: process.pid,
          port: PORT,
          host: HOST,
          uptimeSec: Math.round(process.uptime()),
          memoryMb: Math.round(process.memoryUsage().rss / 1048576),
          log: recent(30),
          stats: stats(),
        }),
      );
    }

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('ok');
    }

    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = normalize(join(PUBLIC_DIR, relative));
    if (!file.startsWith(PUBLIC_DIR)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('Forbidden');
    }

    const body = await readFile(file);
    const ext = extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      const recovered = recoverSpaRequest(req, url);
      if (recovered) {
        const keepMethod = req.method === 'GET' || req.method === 'HEAD' ? 302 : 307;
        res.writeHead(keepMethod, { location: recovered, 'cache-control': 'no-store' });
        return res.end();
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    console.error('[veil] request failed:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    }
    res.end('Internal error');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Veil proxy listening on http://${HOST}:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
