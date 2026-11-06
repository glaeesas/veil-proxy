// URL rewriting for HTML, CSS and inline styles.
// Everything the browser requests must come back through PROXY_PREFIX so the
// document is rendered by the browser natively (no iframes anywhere).

export const PROXY_PREFIX = '/__p/';

const SKIP_SCHEME = /^(?:data:|blob:|javascript:|mailto:|tel:|about:|magnet:|sms:|chrome:|view-source:)/i;
const URL_ATTRS = [
  'href', 'src', 'action', 'poster', 'formaction', 'data', 'cite',
  'background', 'longdesc', 'manifest', 'data-src', 'data-href', 'data-original',
];

/** Turn an arbitrary URL value into a proxied absolute path, or return null. */
export function proxify(value, baseUrl) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v || v.startsWith('#')) return null;
  if (SKIP_SCHEME.test(v)) return null;
  try {
    const resolved = new URL(v.startsWith('//') ? `https:${v}` : v, baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    return PROXY_PREFIX + resolved.href;
  } catch {
    return null;
  }
}

function escAttr(value) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// Attribute values arrive HTML-escaped. Decode one level before resolving so the
// re-escaped output is not double-encoded (&amp;amp; -> &amp;).
function unescAttr(value) {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&#0*38;|&#x0*26;/gi, '&');
}

function rewriteSrcset(value, baseUrl) {
  return value
    .split(',')
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return '';
      const [rawUrl, ...descriptors] = trimmed.split(/\s+/);
      const proxied = proxify(rawUrl, baseUrl);
      return [proxied || rawUrl, ...descriptors].join(' ');
    })
    .filter(Boolean)
    .join(', ');
}

/** Rewrite url(), @import and image-set() references inside a stylesheet. */
export function rewriteCss(css, baseUrl) {
  let out = css.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (match, quote, raw) => {
    const proxied = proxify(raw, baseUrl);
    return proxied ? `url(${proxied})` : match;
  });
  out = out.replace(/@import\s+(['"])([^'"]+)\1/gi, (match, quote, raw) => {
    const proxied = proxify(raw, baseUrl);
    return proxied ? `@import url(${proxied})` : match;
  });
  return out;
}

// Absolute URLs embedded inside scripts and JSON are invisible to attribute
// rewriting, but they are exactly what breaks single-page apps such as YouTube.
// Only quoted whole-string URLs are touched, so escaped (\/) and relative ones
// are left alone.
const ABS_URL_IN_STRING = /(["'`])(https?:\/\/([^\s"'`\\<>]+))\1/g;

export function rewriteJs(text) {
  return text.replace(ABS_URL_IN_STRING, (match, quote, url) => {
    if (url.startsWith(PROXY_PREFIX)) return match;
    return quote + PROXY_PREFIX + url + quote;
  });
}

function rewriteMetaRefresh(html, baseUrl) {
  return html.replace(
    /(<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*>)/gi,
    (tag) => {
      const content = /\bcontent\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
      if (!content) return tag;
      const raw = content[2] ?? content[3] ?? '';
      const match = /^\s*(\d*)\s*;\s*url\s*=\s*['"]?([^'"]+)['"]?\s*$/i.exec(raw);
      if (!match) return tag;
      const proxied = proxify(match[2], baseUrl);
      if (!proxied) return tag;
      const escaped = escAttr(`${match[1] || 0};url=${proxied}`);
      return tag.replace(content[0], `content="${escaped}"`);
    },
  );
}

/**
 * Rewrite a full HTML document so every subresource and navigation goes
 * through the proxy, then inject the runtime shim + floating toolbar.
 */
export function rewriteHtml(html, targetUrl) {
  const base = new URL(targetUrl);

  // A <base> keeps runtime-created relative URLs resolving into the proxy.
  let out = html.replace(/<base\b[^>]*>/gi, '');

  // Sub-resource integrity hashes cannot survive rewriting.
  out = out.replace(/\sintegrity\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // The proxy origin must not inherit the upstream page's security policy.
  out = out.replace(
    /<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi,
    '',
  );

  // Standard URL-bearing attributes.
  const attrRe = new RegExp(
    `\\b(${URL_ATTRS.join('|')})\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`,
    'gi',
  );
  out = out.replace(attrRe, (match, name, _whole, dq, sq, bare) => {
    const raw = unescAttr(dq ?? sq ?? bare ?? '');
    const proxied = proxify(raw, base.href);
    if (!proxied) return match;
    return `${name}="${escAttr(proxied)}"`;
  });

  // srcset takes a comma separated list.
  out = out.replace(/\bsrcset\s*=\s*("([^"]*)"|'([^']*)')/gi, (match, _w, dq, sq) => {
    const raw = unescAttr(dq ?? sq ?? '');
    return `srcset="${escAttr(rewriteSrcset(raw, base.href))}"`;
  });

  // Inline style attributes and <style> blocks.
  out = out.replace(/\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi, (match, _w, dq, sq) => {
    const raw = unescAttr(dq ?? sq ?? '');
    const next = rewriteCss(raw, base.href);
    return next === raw ? match : ` style="${escAttr(next)}"`;
  });
  // Scripts emitted inline also carry absolute URLs.
  out = out.replace(
    /(<script\b(?![^>]*\bsrc=)[^>]*>)([\s\S]*?)(<\/script>)/gi,
    (_m, open, js, close) => open + rewriteJs(js) + close,
  );
  out = out.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, open, css, close) => {
    return open + rewriteCss(css, base.href) + close;
  });

  out = rewriteMetaRefresh(out, base.href);

  const baseDir = new URL('.', base.href).href;
  const config = {
    prefix: PROXY_PREFIX,
    origin: base.origin,
    href: base.href,
  };
  const injected =
    `<base href="${escAttr(PROXY_PREFIX + baseDir)}">` +
    `<script>window.__PX_CONFIG=${JSON.stringify(config).replace(/</g, '\\u003c')};</script>` +
    `<script src="/shim.js" data-px></script>`;

  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head[^>]*>/i, (tag) => tag + injected);
  } else {
    out = injected + out;
  }

  return out;
}
