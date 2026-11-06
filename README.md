# Veil

A URL-rewriting web proxy with twelve themes. Pages are fetched **server side**, and every link,
stylesheet, script, form action and cookie is rewritten so the browser renders the real document —
there are **no iframes** anywhere in this project.

```
npm start        # http://localhost:3000
```

No dependencies. Node 18+ (uses the built-in `fetch`).

## How it works

| Path | Purpose |
| --- | --- |
| `/` | Themed landing page (address bar, quick links, recent history) |
| `/__p/<absolute-url>` | Proxy endpoint — fetches, rewrites and returns the target |
| `/shim.js` | Runtime shim injected into proxied pages |
| `/healthz` | Liveness probe |

1. `lib/proxy.js` fetches the target with the browser's own headers, follows redirects manually and
   re-emits them through `/__p/`, and re-scopes `Set-Cookie` (drops `Domain`, `Secure`, `SameSite`)
   so sessions survive between requests.
2. Security headers that would break a rewrite (`Content-Security-Policy`, `X-Frame-Options`, HSTS,
   `Cross-Origin-*`) are dropped, and `integrity` attributes are removed since the bytes changed.
3. `lib/rewrite.js` rewrites `href`, `src`, `action`, `poster`, `formaction`, `srcset`, inline
   `style`, `<style>` blocks, CSS `url()`/`@import`, and `<meta refresh>`.
4. A `<base>` tag plus `public/shim.js` keep runtime-created URLs inside the proxy: `fetch`,
   `XMLHttpRequest`, `window.open`, `history.pushState`, `setAttribute`, and click handlers are all
   patched. The shim also mounts a small floating toolbar (shadow DOM, so it can't collide with page
   CSS) with back / home / reload / hide.

### Security

Loopback, private, link-local and cloud-metadata addresses are refused (SSRF guard), requests time
out after 25s, and response bodies are capped at 16 MB.

## Themes

Twelve palettes in `public/styles.css`, selected through the drawer and stored in `localStorage`:
Midnight, Obsidian, Nord, Sakura, Sunset, Emerald, Cyberpunk, Mocha, Paper, Ocean, Amethyst, Terminal.

Adding one: copy any `[data-theme="…"]` block in `public/styles.css` and add the matching entry to
the `THEMES` array in `public/app.js`.

## GitHub Codespaces

The repo ships a `.devcontainer` that installs nothing (there are no dependencies) and starts the
server on attach:

- Open the repo → **Code** → **Codespaces** → **Create codespace**.
- Port `3000` auto-forwards and opens a preview.
- The forwarded port is requested as **public**; if it comes up private, open the **Ports** tab,
  right-click port 3000 → *Port Visibility* → *Public*. That link is the live proxy.

## Known limits

This is a DOM-rewriting proxy, so a page is only as proxied as its URLs are visible in the response.
Sites that build URLs from strings at runtime, use `ServiceWorker`-cached assets, hard-code absolute
origins in JS bundles, or require WebSockets (live chat, some video players) can partially or
entirely bypass the proxy. Streaming media that relies on byte-range requests may also degrade.
For those, a Service-Worker-based proxy (e.g. Ultraviolet-style) is the right architecture — it works
on a different design than this one.

## License

MIT
