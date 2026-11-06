import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleProxy, PROXY_PREFIX } from './lib/proxy.js';

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

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname.startsWith(PROXY_PREFIX)) {
      return await handleProxy(req, res);
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
      'cache-control': relative.endsWith('shim.js') ? 'no-cache' : 'public, max-age=300',
      'x-content-type-options': 'nosniff',
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

server.listen(PORT, HOST, () => {
  console.log(`Veil proxy listening on http://${HOST}:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
