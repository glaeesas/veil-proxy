# Veil

A themed web proxy that runs as a **static site**. GitHub Pages serves the files; rewriting happens
in a service worker (Ultraviolet); the TLS/HTTP work is carried by **Epoxy** over the **Wisp**
protocol to a small server you run. No iframes anywhere, no per-request Node proxy, and no build
output checked in.

```
npm install
npm run build      # vendors Ultraviolet + Epoxy into public/uv/
npm start          # http://localhost:3000  (static files + Wisp on /wisp/)
```

## Why it is built this way

A rewriting proxy normally needs a server: fetch the page, rewrite every URL, hand it back. Pages
cannot do that, so Veil is split in two:

| Piece | Runs where | Job |
| --- | --- | --- |
| `public/` | GitHub Pages (or any static host) | The whole UI, the service worker, Ultraviolet, Epoxy |
| Wisp server | `server.js`, a container, a VPS | Opens raw TCP/TLS streams on request; knows nothing about HTML |

The browser keeps its own origin, so cookies, `localStorage` and same-origin rules behave normally,
while the actual bytes come from the target through the Wisp socket.

## How a page loads

1. The landing page registers `public/sw.js` (at the site root, so its scope is the whole origin
   without needing a `Service-Worker-Allowed` header that Pages cannot send) and sets the **Epoxy**
   transport for the **Wisp** URL — `wss://<host>/wisp/` by default, overridable in Settings.
2. The transport lives in a `SharedWorker` (`public/uv/bare-mux-worker.js`), because the service
   worker itself has no `WebSocket`.
3. Pressing Enter opens `/<prefix>/<encoded target>` in a new tab. The service worker intercepts
   that navigation, asks the transport for the page, and lets Ultraviolet rewrite the HTML, CSS,
   scripts and JSON.
4. The rewritten document runs in ordinary page scope, and `public/toolbar.js` is injected into it
   for navigation and the anti-close guard.

`scripts/build.mjs` copies the vendored files into `public/uv/` and writes two generated files:
`public/sw.js` (the worker entry) and `public/uv/uv.config.js` (paths derived at runtime, so the same
build works at a domain root and at `/<repo>/` on Pages).

## Deploying to GitHub Pages

The workflow in `.github/workflows/pages.yml` builds and publishes on every push to `main`.

1. Repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push to `main`. The site appears at `https://<user>.github.io/<repo>/`.
3. Run a Wisp server somewhere (below) and paste its URL into **Settings → Wisp server**:
   `wss://wisp.example.com/wisp/`. Pages itself cannot host the socket — or set the
   `VEIL_WISP_URL` repository variable so the built site already points at it.

Nothing needs to be committed from `public/uv/` or `public/sw.js`; they are generated (and ignored).

## Running the Wisp server

`server.js` serves the static build **and** attaches [`@mercuryworkshop/wisp-js`](https://github.com/MercuryWorkshop/wisp-js)
to the HTTP upgrade event:

```js
server.on('upgrade', (req, socket, head) => {
  if (path !== '/wisp/') return socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
  wisp.routeRequest(req, socket, head);
});
```

That is the only backend Veil needs. It has no HTML knowledge, no rewriting rules and no per-site
configuration — it just opens streams as the Wisp protocol asks.

**Render (one click).** `render.yaml` is a blueprint for the `Dockerfile`: the image installs
dependencies, runs the vendoring build, and starts `server.js` on Render's `$PORT`.

1. Open <https://render.com/deploy?repo=https://github.com/glaeesas/veil-proxy> and apply the
   blueprint (free plan, `oregon`). No environment variables to fill in.
2. Wait for the first build, then copy the service URL. The Wisp endpoint is
   `wss://<service>.onrender.com/wisp/` — `https://<service>.onrender.com/healthz` should say `ok`
   and `…/__debug/state` shows `wisp.upgrades` climbing as clients connect.
3. Make that URL the site's default: repo → **Settings → Secrets and variables → Actions →
   Variables → New repository variable**, name `VEIL_WISP_URL`, value
   `wss://<service>.onrender.com/wisp/`. `scripts/build.mjs` bakes it into `public/veil-config.js`,
   so pressing Enter works without touching Settings. Re-run the Pages workflow (or push) to pick
   it up. Settings → **Wisp server** still overrides it per browser.

Render's free plan sleeps after idle, so the first connection of the day waits for a cold start
(a few seconds to ~30s); the status pill shows `connecting` until the socket is up. Any other host
that can run a WebSocket works the same way — Fly.io, Railway, Koyeb, or a small VPS with Caddy in
front; only the URL in `VEIL_WISP_URL` changes.

Wisp speaks raw TCP from your server, so it is worth restricting: keep it on a host you control, and
do not expose it publicly without rate limiting or auth in front.

## Keeping the connection alive

The service worker borrows the transport from an **open Veil tab** — that is the one architectural
cost of having no backend do the fetching. Two consequences:

- Clicking a result opens the proxied site in a **new tab** and leaves the Veil tab open as the
  carrier. Keep that tab open while you browse; close it and the next navigation shows the error
  page until you reopen Veil.
- A proxied page cannot create its own `SharedWorker`, so it cannot take over the role itself.

## What was removed

The old version fetched and rewrote pages in Node (`lib/proxy.js`, `lib/rewrite.js`) and routed
everything through `/__p/<base64>`. That cannot run on a static host, so it is gone: rewriting is
Ultraviolet's job now, and the server only carries sockets. The hand-written debug overlay
(`public/debug.js`) still loads on the landing page.

## Features

- **Twelve themes**, chosen in the drawer and stored per browser (Midnight, Obsidian, Nord, Sakura,
  Sunset, Emerald, Cyberpunk, Mocha, Paper, Ocean, Amethyst, Terminal).
- **Anti-close guard** — on by default: closing a proxied tab raises Chrome's native "Leave site?"
  prompt. That is the browser's own `beforeunload` dialog, so it cannot be restyled, and Chrome
  suppresses it until you have interacted with the page. In-proxy navigation is exempt.
- **DevTools overlay** on the landing page (`Ctrl+Alt+D`, `?debug=1`, or the bug button): console,
  elements, network, resources, sources, snippets, page info and settings, all reading the real page.
- **Omnibox** — an address goes straight through the proxy, anything else goes to your chosen search
  engine (plain-HTML endpoints by default, because JS-only result pages are unreliable through a
  rewriter).

## Limits

- Cross-origin fetches, `SharedWorker`-dependent sites and anything that requires the target's
  original origin (DRM video, some auth flows) behave differently or fail.
- Google sign-in and bot-guarded APIs reject proxied traffic.
- The Wisp server sees the plaintext of every stream it carries. Run your own.
- Ultraviolet rewrites markup; a site that assembles URLs at runtime from fragments can still
  escape. That is inherent to rewriting, not a tuning problem.

## License

MIT. Ultraviolet, Epoxy, bare-mux and wisp-js keep their own licenses (AGPL-3.0 for Epoxy).
