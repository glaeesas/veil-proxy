import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { server as wisp } from '@mercuryworkshop/wisp-js/server';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const startedAt = Date.now();
let upgrades = 0;

const server = createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/__debug/state') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(
        JSON.stringify({
          ok: true,
          mode: 'static + wisp',
          node: process.version,
          platform: `${process.platform}/${process.arch}`,
          pid: process.pid,
          port: PORT,
          host: HOST,
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          memoryMb: Math.round(process.memoryUsage().rss / 1048576),
          wisp: { path: '/wisp/', upgrades },
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
      'cache-control': ext === '.html' || ext === '.js' || ext === '.mjs' ? 'no-cache' : 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      ...(url.pathname === '/sw.js' ? { 'service-worker-allowed': '/' } : {}),
    });
    res.end(body);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
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

// The Wisp endpoint: a WebSocket that carries raw TCP/TLS streams for Epoxy.
// Nothing else is proxied by this process — rewriting happens in the browser.
server.on('upgrade', (req, socket, head) => {
  const path = (req.url || '').split('?')[0];
  if (path !== '/wisp/' && path !== '/wisp') {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    return;
  }
  upgrades += 1;
  wisp.routeRequest(req, socket, head);
});

server.listen(PORT, HOST, () => {
  console.log(`Veil static build on http://${HOST}:${PORT}`);
  console.log(`Wisp server on ws://${HOST}:${PORT}/wisp/`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
