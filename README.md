# Veil

A URL-rewriting web proxy with twelve themes and an anti-close guard. Pages are fetched **server
side**, and every link, stylesheet, script, form action and cookie is rewritten so the browser
renders the real document — there are **no iframes** anywhere in this project.

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
   CSS) with back / home / reload / DevTools / anti-close toggle / hide.

### Security

Loopback, private, link-local and cloud-metadata addresses are refused (SSRF guard), requests time
out after 25s, and response bodies are capped at 16 MB.

## Debugging

Press **Ctrl+Alt+D** (Cmd+Alt+D on macOS) on any Veil page — the landing page, an error page, or
inside a proxied site — or add `?debug=1` to a URL, or click the bug button on the floating toolbar.
It opens as a full DevTools: a tab strip across the whole window and nine panels underneath.

It shows, without leaving the page:

- the opaque address alongside the **real proxied target**, decoded for you;
- the matching server-side request record: status, duration, bytes, upstream status, trace id and error;
- server facts from `/__debug/state` — Node version, uptime, port, memory, request count;
- which shim patches are live (`fetch`, XHR, history, Navigation API), so a site that escapes the
  proxy is obvious at a glance;
- your stored `veil.*` settings;
- the last dozen proxied requests, newest first, failures highlighted;
- a **probe** box that pushes a URL through the proxy and reports status and timing;
- **Copy report**, which puts all of the above (plus user agent and viewport) on the clipboard as JSON.

### Tabs

| Tab | What it does |
| --- | --- |
| **Console** | Everything the page logs, throws or fails to fetch, plus a JS prompt that runs in the page's own global scope |
| **Elements** | Live DOM tree with disclosure triangles, a breadcrumb, element picker, editable attributes, and the CSS rules that actually match the selected node |
| **Network** | Every request the page makes — wrapped `fetch`/`XHR` with real status and response headers, plus other resources from the Resource Timing API with size and duration |
| **Resources** | `localStorage`, `sessionStorage` and the cookies the page can see, with delete and add |
| **Sources** | Every script and stylesheet on the page, fetched through the proxy, with line numbers and find-in-file |
| **Snippets** | Saved scripts that run in the page on demand (stored in `localStorage`, never sent anywhere) |
| **Info** | Page, document, timing and shim facts |
| **Veil** | The proxy-specific view: decoded target, the server's request record, trace id, patch status, probe |
| **Settings** | Capture toggles, buffer clearing, reload/home, and the control that opens this panel |

**Elements** is the interesting one. The tree expands a node at a time from the live DOM; clicking a
node selects it and outlines it on the page, the breadcrumb walks back up, and the sidebar shows the
attributes you can edit in place plus the stylesheets' rules that match — sorted by specificity, with
the cross-origin sheets it could not read counted. Unchecking a declaration really removes it from
that rule (or from `element.style`), so the page repaints and re-checking restores the exact value.
The **Pick element** button dims the panel and takes the next click on the page.

Two limits are worth stating plainly: cross-origin stylesheets cannot be read from script, so their
rules are missing (DevTools reads them through the browser's own privileged access); and there is no
JavaScript debugger — no breakpoints, stepping or call stack, because that needs a DevTools protocol
client, not a script tag.

### Console

The **Console** tab is a working DevTools console for the page you are on. `debug.js` loads
synchronously, ahead of the site's own scripts, so it captures from the first line: `console.log`,
`info`, `warn`, `error`, `debug`, uncaught exceptions with their stack, unhandled promise rejections,
and failed `fetch` / `XMLHttpRequest` calls with their status.

- the prompt evaluates JavaScript **in the page's own global scope**, so the site's variables and
  libraries are in scope; expressions return their value, statements run for effect, and promises
  report what they settled with;
- `↑` / `↓` walk the command history and `Ctrl+L` clears the view;
- the filter box narrows by text, and the tab badge counts errors;
- the buffer holds the last 400 entries in memory only — nothing is sent anywhere.

`window.__veilDebug` exposes `open`, `close`, `toggle`, `refresh`, `tab`, `report()`,
`console.{run, clear, entries}`, `network.{entries, clear}` and `elements.{select, selected, rules}`,
so the same panels can be driven from outside the overlay.

`/__debug/state` returns the same data as JSON. It is same-origin and read-only apart from
`?clear=1`, which empties the in-memory log; there is no response body, cookie value or credential
in it.

### Error screens

Every proxy failure renders a page that names the cause instead of just echoing a status code:
status, target URL, error code, upstream status, trace id and timestamp, plus a **what to try** note
written for that specific failure — an unresolvable hostname, a bad certificate, a timeout, a refused
connection, a blocked private address, an oversized upload. The trace id in the panel matches the one
in the server log, so the debug overlay can show the exact request behind the error.

## Anti-close guard

On by default, and shared between the landing page and every proxied page (`veil.anticlose` in
`localStorage`): closing or reloading a proxied tab raises the browser's own **"Leave site?"**
confirmation with a *Cancel* / *Leave* pair.

That is Chrome's native `beforeunload` prompt, not a page-drawn dialog, so it cannot be styled or
reworded by Veil. Two browser rules come with it:

- Chrome suppresses it until you have clicked or typed on the page at least once (sticky user
  activation). A tab you open and immediately close will close silently — that is Chrome, not Veil.
- Chrome offers its own *"Prevent this page from creating additional dialogs"* checkbox. Ticking it
  disables the prompt for that tab.

In-proxy navigation (links that stay inside the proxy) is exempt, so normal browsing does not
prompt. The toolbar shield button toggles the guard from inside a proxied page; the landing page has
the same switch in the theme drawer.

## Keep it running without Codespaces

A Codespace **stops** after its idle timeout (30 minutes by default) and can never be left running
indefinitely, so its forwarded URL is not a permanent host. To get a URL that outlives the
Codespace, deploy the same container image to any host:

**Render (free, no credit card).** This repo ships `render.yaml` and `Dockerfile`:

1. Sign in at [render.com](https://render.com) → **New** → **Blueprint**.
2. Pick this repository. Render reads `render.yaml` and builds the `Dockerfile`.
3. You get `https://veil-proxy-<something>.onrender.com`. Point Veil at it and it stays up.

Render's free plan sleeps after ~15 minutes of no traffic and wakes on the next request (first hit
takes ~30–50s). Any container host works the same way, e.g. Fly.io, Railway, Koyeb, or a VPS with
`docker build -t veil . && docker run -p 3000:3000 veil`.

**Keeping the Codespace alive instead:** set *Codespaces → idle timeout* in your GitHub
[settings](https://github.com/settings/codespaces) to 240 minutes, and note that a stopped Codespace
still keeps your files — only the running server goes away until you reopen it.

## YouTube

YouTube's SPA is rewritten rather than framed, so its shell renders: header, guide, search, and the
signed-out feed state all work through `/__p/https://www.youtube.com`. Three things make this
different from proxying a normal page:

- JS and JSON bodies are rewritten, so `youtubei/v1/*` calls and `i.ytimg.com` assets resolve through
  the proxy.
- `Origin`/`Referer` are reconstructed upstream, which those endpoints require.
- Media still comes from `googlevideo.com` with signed URLs, and Google's bot-guard endpoints
  (`jnn-pa.googleapis.com`, WAA) reject proxied traffic with 403. Expect playback to be unreliable —
  the shell browses, videos often will not play, and sign-in is blocked by Google.

For dependable playback you need a Service-Worker proxy (Ultraviolet/Rammerhead style) plus a
youtubei-level backend, which is a different architecture, not a rewrite rule.

## Themes

Twelve palettes in `public/styles.css`, selected through the drawer and stored in `localStorage`:
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
