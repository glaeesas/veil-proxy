# Veil

A URL-rewriting web proxy with twelve themes, a settings drawer and an anti-close guard. Pages are
fetched **server side**, and every link, stylesheet, script, form action and cookie is rewritten so
the browser renders the real document — there are **no iframes** anywhere in this project.

```
npm start        # http://localhost:3000
```

No dependencies. Node 18+ (uses the built-in `fetch`).

## How it works

| Path | Purpose |
| --- | --- |
| `/` | Themed landing page (address bar, quick links, recent history, settings) |
| `/__p/<opaque>` | Proxy endpoint — fetches, rewrites and returns the target |
| `/shim.js` | Runtime shim injected into proxied pages |
| `/settings.css` | Styles for the settings drawer |
| `/healthz` | Liveness probe |

1. `lib/proxy.js` fetches the target with the browser's own headers, follows redirects manually and
   re-emits them through `/__p/`, and re-scopes `Set-Cookie` (drops `Domain`, `Secure`, `SameSite`)
   so sessions survive between requests.
2. Subresource requests look same-origin to the proxy, so the browser sends no `Origin`/`Referer`.
   They are re-attached from the target (`headers.origin` / `headers.referer`), which media and API
   endpoints require.
3. Security headers that would break a rewrite (`Content-Security-Policy`, `X-Frame-Options`, HSTS,
   `Cross-Origin-*`) are dropped, and `integrity` attributes are removed since the bytes changed.
4. `lib/rewrite.js` rewrites `href`, `src`, `action`, `poster`, `formaction`, `srcset`, inline
   `style`, `<style>` blocks, CSS `url()`/`@import`, `<meta refresh>`, inline `<script>` bodies, and
   — for `text/javascript` and `application/json` responses — absolute URLs inside quoted strings.
   That last part is what lets single-page apps (YouTube, among others) work at all: their bundles
   and API payloads contain the absolute URLs the DOM rewriting can never see.
5. A `<base>` tag plus `public/shim.js` keep runtime-created URLs inside the proxy: `fetch`,
   `XMLHttpRequest`, `window.open`, `history.pushState`, `setAttribute`, and click handlers are all
   patched. The shim also mounts a small floating toolbar (shadow DOM, so it can't collide with page
   CSS) with back / home / reload / anti-close toggle / hide.

### Opaque destinations

A proxy path carries **no visible URL**. `/__p/aHR0cHM6Ly9leGFtcGxlLmNvbS8` is the base64url of the
target, so hovering a link, reading the address bar, or copying a link never spells out where it
goes — including search queries. The server decodes the segment, and a directory segment (used by
`<base>` for relative URLs) is joined with whatever the browser appends. Readable
`/__p/https://example.com` paths still resolve, so old links keep working.

### Security

Loopback, private, link-local and cloud-metadata addresses are refused (SSRF guard), requests time
out after 25s, and response bodies are capped at 16 MB.

## Settings

Open **Settings** in the top bar. Everything is stored per browser in `localStorage`.

| Setting | Key | What it does |
| --- | --- | --- |
| Theme | `veil.theme` | Twelve palettes. |
| Search engine | `veil.engine` | Engine used when the address bar gets a query rather than a URL. |
| Title | `veil.title` | Tab title and the name in the top bar. |
| Wisp server | `veil.wisp` | Saved Wisp relay URL. |
| Confirm before closing | `veil.anticlose` | The anti-close guard. |

The **Wisp server** field is stored but nothing consumes it: this proxy fetches upstream traffic
from the Node process, so there is no browser-side Wisp transport to point anywhere. Wire it up only
if you add an Ultraviolet/Rammerhead-style client.

### Search engines

Only engines that serve plain HTML are listed, because a JavaScript-only results page renders blank
through a rewrite proxy — `duckduckgo.com/?q=` is exactly that, which is why the default is
`html.duckduckgo.com/html/?q=`. Bing and Startpage work; Brave returns HTTP 429 to the proxy often
and Google usually shows a consent interstitial, so both are included but unreliable.

## Anti-close guard

On by default and shared between the landing page and every proxied page: closing or reloading a
proxied tab raises the browser's own **"Leave site?"** confirmation with a *Cancel* / *Leave* pair.

That is the native `beforeunload` prompt, not a page-drawn dialog, so it cannot be styled or reworded
by Veil. Two browser rules come with it:

- It only appears after you have clicked or typed on the page at least once (sticky user
  activation). A tab you open and immediately close closes silently — that is the browser, not Veil.
- The browser's own *"Prevent this page from creating additional dialogs"* checkbox disables it for
  that tab.

In-proxy navigation is exempt, so normal browsing does not prompt. The toolbar shield button toggles
the guard from inside a proxied page; the settings drawer has the same switch.

## Keep it running without Codespaces

A Codespace **stops** after its idle timeout (30 minutes by default) and can never be left running
indefinitely, so its forwarded URL is not a permanent host. To get a URL that outlives the
Codespace, deploy the same container image to any host.

**Render (free, no credit card).** This repo ships `render.yaml` and `Dockerfile`:

1. Sign in at [render.com](https://render.com) → **New** → **Blueprint**.
2. Pick this repository. Render reads `render.yaml`, builds the `Dockerfile`, and serves it.
3. You get `https://veil-proxy-<something>.onrender.com`, up even when Codespaces is closed.

Render's free plan sleeps after ~15 minutes without traffic and wakes on the next request, so the
first hit after a nap takes ~30–50s. Any container host works the same way (Fly.io, Railway, Koyeb),
as does a VPS:

```
docker build -t veil .
docker run -d -p 3000:3000 -e PORT=3000 --name veil veil
```

**Keeping the Codespace alive instead:** raise *Codespaces → idle timeout* in your GitHub
[settings](https://github.com/settings/codespaces) to 240 minutes. A stopped Codespace still keeps
your files — only the running server goes away until you reopen it.

## YouTube

YouTube's SPA is rewritten rather than framed, so its shell renders: header, guide, search, and the
signed-out feed state all work through `/__p/`. Media still comes from `googlevideo.com` with signed
URLs, and Google's bot-guard endpoints (`jnn-pa.googleapis.com`, WAA) reject proxied traffic with
403, so expect playback to be unreliable and sign-in to be blocked. Dependable playback needs a
Service-Worker proxy (Ultraviolet/Rammerhead style) plus a youtubei-level backend.

## Themes

Twelve palettes in `public/styles.css`, selected in the settings drawer:
Midnight, Obsidian, Nord, Sakura, Sunset, Emerald, Cyberpunk, Mocha, Paper, Ocean, Amethyst, Terminal.

Adding one: copy any `:root[data-theme="…"]` block in `public/styles.css` and add the matching entry
to the `THEMES` array in `public/app.js`. Keep palettes scoped to `:root` — the theme cards carry
`data-theme` attributes themselves and would otherwise inherit a foreign palette.

## GitHub Codespaces

The repo ships a `.devcontainer` that installs nothing (there are no dependencies) and starts the
server on attach:

- Open the repo → **Code** → **Codespaces** → **Create codespace**.
- Port `3000` auto-forwards and opens a preview.
- The forwarded port is requested as **public**; if it comes up private, open the **Ports** tab,
  right-click port 3000 → *Port Visibility* → *Public*. That link is the live proxy.

## Known limits

A page is only as proxied as its URLs are visible in the response. Sites that assemble URLs from
fragments at runtime, use ServiceWorker caches, or depend on WebSockets (live chat, some players)
can still bypass the proxy. Streaming media that relies on byte-range requests may degrade. Google
sign-in, bot-guarded APIs and DRM video are out of scope.

## License

MIT
